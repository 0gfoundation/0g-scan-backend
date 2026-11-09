import {ethers} from "ethers";
import {Op, QueryTypes} from "sequelize";
import {ConfigInstance} from "../../config/StatConfig";
import {StakingDelegation, StakingEvent, StakingEventType, StakingValidator} from "../../model/Staking";
import {safeAddErrorLog} from "../../monitor/ErrorMonitor";
import {SECOND} from "../common/utils";
import {validatorRpcUrl} from "../ZGSupply";
import {VALIDATOR_ABI} from "./StakingAbi";
import {getStakingCursor, stakingOption, trackedBeacon, withStakingLock} from "./StakingSync";

/**
 * Periodic refresh of the validator rows from chain state, plus the checks
 * that stand in for events we cannot see.
 *
 * Rewards accrue every block through a system call, so tokens/rewards/
 * commission can only be read, never derived. Slashing is also a system call
 * and only reduces the operator's shares; the consistency check below notices
 * that and corrects the operator's row.
 *
 * Consistency checks read chain state at the sync cursor block, so they
 * compare like with like; they are skipped while the sync is catching up,
 * because a non-archive node cannot serve state that far back.
 */

/** how far behind latest the cursor may be for state reads at the cursor block */
const MAX_STATE_LAG = 64;
const FULL_RECONCILE_INTERVAL = 3600 * SECOND;
/**
 * The batch provider sends every call issued in the same tick as one JSON-RPC
 * batch, and the 0G RPCs reject the part of a batch beyond 50 calls with
 * -32005 "request rate exceeded" (ethers then reports a bare CALL_EXCEPTION).
 * Chunk sizes keep each batch under that: up to 16 calls per validator when
 * refreshing state (3 x 16 = 48), 2 per validator per step in the share check,
 * 1 per delegation when reconciling.
 */
const CHUNK_STATE = 3;
const CHUNK_SHARE_CHECK = 10;
const CHUNK_RECONCILE = 40;
const RATE_LIMIT_RETRIES = 5;

const ctx = {
    provider: null as ethers.providers.JsonRpcBatchProvider,
    lastFullReconcile: 0,
};

function provider() {
    if (!ctx.provider) {
        // batches the per-validator view calls issued in the same tick
        ctx.provider = new ethers.providers.JsonRpcBatchProvider(ConfigInstance.ether.url);
    }
    return ctx.provider;
}

function validatorContract(address: string) {
    return new ethers.Contract(address, VALIDATOR_ABI, provider());
}

async function inChunks<T>(list: T[], size: number, fn: (t: T) => Promise<any>) {
    for (let i = 0; i < list.length; i += size) {
        await Promise.all(list.slice(i, i + size).map(fn));
    }
}

function isRateLimited(e: any): boolean {
    const text = `${e?.message || ''} ${JSON.stringify(e?.error || '')}`;
    return /-32005|rate exceeded|too many requests/i.test(text);
}

/** Retries RPC calls rejected by the rate limit, backing off 200ms, 400ms, ... */
async function rpc<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (attempt >= RATE_LIMIT_RETRIES || !isRateLimited(e)) {
                throw e;
            }
            await new Promise(r => setTimeout(r, 200 * 2 ** attempt));
        }
    }
}

const lower = (a: string) => (a || '').toLowerCase();
const str = (v: any) => v.toString();

/** Contract state of every validator at `latest`. A failing validator is left as is. */
async function refreshContractState(latest: number) {
    const rows = await StakingValidator.findAll({attributes: ['address', 'pubkey'], raw: true});
    let failed = 0;
    await inChunks(rows, CHUNK_STATE, async row => {
        const c = validatorContract(row.address);
        const o = {blockTag: latest};
        try {
            const [owner, operator, desc, commissionRate, withdrawalFeeInGwei, tokens, rewards,
                delegatorShares, commission, tipFee, stakes, apy, bondStatus, minSelf, pubkey] = await rpc(() => Promise.all([
                c.owner(o), c.operatorAddress(o), c.description(o), c.commissionRate(o), c.withdrawalFeeInGwei(o),
                c.tokens(o), c.rewards(o), c.delegatorShares(o), c.commission(o), c.tipFee(o), c.stakes(o),
                c.annualPercentageYield(o), c.bondStatus(o), c.minSelfDelegationInGwei(o),
                row.pubkey ? Promise.resolve(null) : c.consensusPubkey(o),
            ]));
            const fields: any = {
                owner: lower(owner), operator: lower(operator),
                moniker: desc[0], identity: desc[1], website: desc[2], securityContact: desc[3], details: desc[4],
                commissionRate: Number(commissionRate), withdrawalFeeInGwei: str(withdrawalFeeInGwei),
                tokens: str(tokens), rewards: str(rewards), delegatorShares: str(delegatorShares),
                commission: str(commission), tipFee: str(tipFee), stakes: str(stakes), apy: str(apy), bondStatus: Number(bondStatus),
                minSelfDelegationInGwei: str(minSelf), refreshedBlock: latest, refreshedAt: new Date(),
            };
            if (pubkey && pubkey !== '0x') {
                fields.pubkey = lower(pubkey);
            }
            await StakingValidator.update(fields, {where: {address: row.address}});
        } catch (e) {
            failed++;
            console.log(`staking refresh: validator ${row.address} failed:`, e?.message || e);
        }
    });
    if (failed) {
        safeAddErrorLog('staking', 'refresh', new Error(`${failed} of ${rows.length} validators failed to refresh`));
    }
}

/**
 * Beacon status from the validators endpoint. `validatorRpc` holds the
 * consensus layer's total_withdrawals URL; `validatorRpcUrl()` derives
 * .../states/head/validators from it, and is empty when it cannot.
 * Failure here must not affect the contract refresh.
 */
async function refreshBeaconStatus() {
    const url = validatorRpcUrl();
    if (!url) {
        return;
    }
    try {
        const resp = await fetch(url).then(r => r.json());
        const byPubkey = new Map<string, any>();
        for (const d of resp?.data || []) {
            byPubkey.set(lower(d.validator?.pubkey), d);
        }
        if (!byPubkey.size) {
            throw new Error(`empty beacon response`);
        }
        const rows = await StakingValidator.findAll({
            attributes: ['address', 'pubkey'], raw: true, where: {pubkey: {[Op.ne]: null}},
        });
        for (const row of rows) {
            const d = byPubkey.get(row.pubkey);
            await StakingValidator.update({
                beaconStatus: d?.status ?? null,
                beaconEffectiveBalance: d?.validator?.effective_balance ?? null,
            }, {where: {address: row.address}});
        }
    } catch (e) {
        console.log(`staking refresh: beacon status failed:`, e?.message || e);
        safeAddErrorLog('staking', 'beacon', e);
    }
}

/**
 * At the cursor block, compares each validator's operator shares and total
 * shares with the DB. Must run under the sync lock.
 *
 * Operator shares lower on chain than in the DB with nothing else explaining
 * it is a slash: the row is corrected and a SlashDetected row records the
 * drop. Any other mismatch means an event was missed or misdecoded; the row is
 * still corrected to chain state, but it is reported as an error.
 */
async function checkOperatorShares(block: number) {
    const rows = await StakingValidator.findAll({attributes: ['address', 'exitedBlock'], raw: true});
    const blockTime = new Date((await provider().getBlock(block)).timestamp * 1000);
    await inChunks(rows, CHUNK_SHARE_CHECK, async row => {
        const c = validatorContract(row.address);
        const o = {blockTag: block};
        try {
            const operator = lower(await rpc(() => c.operatorAddress(o)));
            if (!operator || operator === ethers.constants.AddressZero) {
                return;
            }
            const [[, chainShares], chainTotal] = await rpc(() => Promise.all([c.getDelegation(operator, o), c.delegatorShares(o)]));
            const opRow = await StakingDelegation.findOne({where: {validator: row.address, delegator: operator}, raw: true});
            const dbShares = BigInt(opRow?.shares ?? 0);
            const onChain = BigInt(str(chainShares));
            // an exit zeroes the owner's shares without an event; the sync zeroes them
            // too, so a leftover here is a correction, not a slash
            const exitSettled = row.exitedBlock != null && onChain === BigInt(0);
            const slash = onChain < dbShares && !exitSettled;
            if (dbShares !== onChain) {
                await StakingDelegation.sequelize.transaction(async dbTx => {
                    if (opRow) {
                        await StakingDelegation.update({shares: onChain.toString()}, {where: {id: opRow.id}, transaction: dbTx});
                    } else {
                        await StakingDelegation.create({
                            validator: row.address, delegator: operator, shares: onChain.toString(),
                            firstBlock: block, lastBlock: block, firstAt: blockTime, lastAt: blockTime,
                        }, {transaction: dbTx});
                    }
                    if (slash) {
                        await StakingEvent.findOrCreate({
                            where: {blockNumber: block, logIndex: -1, validator: row.address},
                            defaults: {
                                blockNumber: block, blockHash: '', createdAt: blockTime, txHash: '', txIndex: -1, logIndex: -1,
                                validator: row.address, eventType: StakingEventType.SlashDetected,
                                account: operator, shares: (dbShares - onChain).toString(),
                            },
                            transaction: dbTx,
                        });
                    }
                });
                const msg = `operator ${operator} of ${row.address} shares db ${dbShares} chain ${onChain} at ${block}`;
                console.log(`staking refresh: ${slash ? 'slash detected' : exitSettled ? 'exit settled' : 'corrected'}, ${msg}`);
                if (onChain > dbShares) {
                    safeAddErrorLog('staking', 'operator-shares', new Error(msg));
                }
            }
            // cast in SQL: Model.sum may hand DECIMAL(65,0) back as a float
            const [{total}]: any[] = await StakingDelegation.sequelize.query(
                `select cast(coalesce(sum(shares), 0) as char) as total from ${StakingDelegation.getTableName()} where validator = ?`,
                {type: QueryTypes.SELECT, replacements: [row.address]});
            const dbTotal = BigInt(total);
            if (dbTotal !== BigInt(str(chainTotal))) {
                safeAddErrorLog('staking', 'total-shares', new Error(
                    `${row.address} total shares db ${dbTotal} chain ${chainTotal} at ${block}`));
            }
        } catch (e) {
            console.log(`staking refresh: share check of ${row.address} failed:`, e?.message || e);
        }
    });
}

/** Every non-zero delegation against getDelegation at the cursor block. Under the sync lock. */
export async function reconcileAllShares(block: number) {
    const rows = await StakingDelegation.findAll({
        attributes: ['id', 'validator', 'delegator', 'shares'], raw: true, where: {shares: {[Op.ne]: 0}},
    });
    let mismatched = 0;
    await inChunks(rows, CHUNK_RECONCILE, async row => {
        const [, chainShares] = await rpc(() => validatorContract(row.validator).getDelegation(row.delegator, {blockTag: block}));
        const onChain = BigInt(str(chainShares));
        if (onChain !== BigInt(row.shares)) {
            mismatched++;
            console.log(`staking reconcile: ${row.validator} ${row.delegator} db ${row.shares} chain ${onChain} at ${block}`);
            await StakingDelegation.update({shares: onChain.toString()}, {where: {id: row.id}});
        }
    });
    console.log(`staking reconcile: ${rows.length} delegations checked at ${block}, ${mismatched} corrected`);
    if (mismatched) {
        safeAddErrorLog('staking', 'reconcile', new Error(`${mismatched} of ${rows.length} delegations corrected at ${block}`));
    }
    return {checked: rows.length, mismatched};
}

export async function stakingRefreshOnce({fullReconcile = false} = {}) {
    const latest = await provider().getBlockNumber();
    await refreshContractState(latest);
    await refreshBeaconStatus();
    await checkValidatorBeacon();

    await withStakingLock(async () => {
        const cursor = await getStakingCursor();
        if (latest - cursor > MAX_STATE_LAG) {
            console.log(`staking refresh: share checks skipped, cursor ${cursor} is ${latest - cursor} blocks behind ${latest}`);
            return;
        }
        await checkOperatorShares(cursor);
        if (fullReconcile || Date.now() - ctx.lastFullReconcile > FULL_RECONCILE_INTERVAL) {
            await reconcileAllShares(cursor);
            ctx.lastFullReconcile = Date.now();
        }
    });
}

/**
 * setValidatorBeacon emits nothing. A new beacon would only serve validators
 * created after the switch, whose upgrades the sync would then miss, so a
 * change is reported (the fix is to track both; see classifyImplementation).
 */
async function checkValidatorBeacon() {
    const tracked = trackedBeacon();
    if (!tracked || stakingOption().validatorBeacon) {
        return;
    }
    const s = new ethers.Contract(stakingOption().contract, ['function validatorBeacon() view returns (address)'], provider());
    const now = (await s.validatorBeacon()).toLowerCase();
    if (now !== tracked) {
        const msg = `the Staking contract's validatorBeacon() is now ${now}, but the sync tracks upgrades of ${tracked}`;
        console.log(`staking refresh: ${msg}`);
        safeAddErrorLog('staking', 'beacon', new Error(msg));
    }
}

export async function runStakingRefresher() {
    try {
        await stakingRefreshOnce();
    } catch (e) {
        console.log(`staking refresh failed:`, e?.message || e);
        safeAddErrorLog('staking', 'refresh', e);
    }
    setTimeout(runStakingRefresher, stakingOption().refreshIntervalMs);
}
