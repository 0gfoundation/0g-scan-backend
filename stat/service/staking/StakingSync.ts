import {JsonRpcProvider} from "@ethersproject/providers/src.ts/json-rpc-provider";
import {Op, QueryTypes, Transaction} from "sequelize";
import {ConfigInstance, StakingOption} from "../../config/StatConfig";
import {KV} from "../../model/KV";
import {IStakingEvent, StakingDelegation, StakingEvent, StakingEventType, StakingValidator} from "../../model/Staking";
import {safeAddErrorLog} from "../../monitor/ErrorMonitor";
import {ethers} from "ethers";
import {initEthSdk, SECOND} from "../common/utils";
import {
    decodeStakingLog,
    DecodedStakingEvent,
    DEFAULT_STAKING_CONTRACT,
    GENESIS_VALIDATORS,
    RawLog,
    STAKING_TOPICS,
    StakingDecodeError,
    VALIDATOR_TOPICS,
} from "./StakingAbi";

/**
 * Forward sync of the 0G staking contracts into staking_validator /
 * staking_delegation / staking_event. Design: document/staking/PLAN.md.
 *
 * Each round takes one block window. It first reads the Staking contract's own
 * logs, which is how validators are discovered, then the logs emitted by the
 * known validator contracts -- filtering by that address set is what keeps
 * look-alike events from arbitrary contracts out. The window's events, the
 * share deltas they imply and the cursor are written in one DB transaction.
 *
 * Reorgs are not handled: 0G finalizes every block through CometBFT, so the
 * window runs up to `latest` (minus `confirmations`, 0 by default). The RPC's
 * `finalized` tag is not used: it trails `latest` by ~10 blocks for nothing.
 */

export const KEY_STAKING_CURSOR = 'STAKING_SYNC_BLOCK';
const KEY_STAKING_GENESIS = 'STAKING_GENESIS_SEEDED';
/**
 * eth_getLogs address-array size. evmrpc.0g.ai rejects more than 32
 * ("filter.address can contain up to 32 addresses"), which mainnet's validator
 * count passed around block 46.4M. An earlier probe with 1,000 (72 distinct,
 * repeated) went through, so the cap may count distinct addresses or differ
 * between the nodes behind it; 32 is what holds.
 */
const ADDRESS_CHUNK = 32;

export function stakingOption(): Required<StakingOption> {
    const o = ConfigInstance.staking || {};
    return {
        enabled: !!o.enabled,
        contract: (o.contract || DEFAULT_STAKING_CONTRACT).toLowerCase(),
        genesis: o.genesis,
        startBlock: o.startBlock ?? 1,
        confirmations: o.confirmations ?? 0,
        // the 0G RPC's eth_getLogs limit (`query exceeds max block range 100000`)
        logRange: o.logRange ?? 100_000,
        refreshIntervalMs: o.refreshIntervalMs ?? 60 * SECOND,
        blockRewards: o.blockRewards || {},
    };
}

/** mainnet's first block with withdrawals; the consensus layer 404s before it */
export const WITHDRAWAL_ACTIVATION_BLOCK = 10_877_918;
const FOUNDATION_ADDRESS = '0x711b0ecb072c27de0e50c9944d7195a51b202522';

export function blockRewardOption() {
    const o = ConfigInstance.staking?.blockRewards || {};
    return {
        enabled: !!o.enabled,
        startBlock: o.startBlock ?? WITHDRAWAL_ACTIVATION_BLOCK,
        batchSize: o.batchSize ?? 50,
        concurrency: o.concurrency ?? 2,
        foundationAddress: (o.foundationAddress || FOUNDATION_ADDRESS).toLowerCase(),
        communityTaxRate: BigInt(o.communityTaxRate ?? 100_000),
        clTotalWithdrawalsUrl: o.clTotalWithdrawalsUrl || ConfigInstance.validatorRpc || '',
        checkIntervalSec: o.checkIntervalSec ?? 3600,
        freshnessAlertSec: o.freshnessAlertSec ?? 600,
    };
}

const ctx = {
    provider: null as JsonRpcProvider,
    validators: new Set<string>(),
    range: 0,
};

/**
 * Serializes a sync window against the refresher's consistency checks, which
 * compare DB shares with chain state at the cursor block and would see a
 * half-applied window as a discrepancy.
 */
let lockTail: Promise<any> = Promise.resolve();
export function withStakingLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lockTail.then(fn, fn);
    lockTail = run.catch(() => undefined);
    return run;
}

export async function getStakingCursor(): Promise<number> {
    const saved = await KV.getNumber(KEY_STAKING_CURSOR);
    return saved ?? stakingOption().startBlock - 1;
}

export async function initStakingSync() {
    const opt = stakingOption();
    ctx.provider = initEthSdk(ConfigInstance.ether?.url);
    if (!ctx.provider) {
        throw new Error(`staking sync needs config.ether.url`);
    }
    if (!GENESIS_VALIDATORS[opt.genesis]) {
        throw new Error(`config.staking.genesis must be one of ${Object.keys(GENESIS_VALIDATORS)}, got [${opt.genesis}]`);
    }
    ctx.range = opt.logRange;
    await seedGenesis(opt.genesis);
    const rows = await StakingValidator.findAll({attributes: ['address'], raw: true});
    rows.forEach(r => ctx.validators.add(r.address));
    console.log(`staking sync: ${ctx.validators.size} validators known, cursor ${await getStakingCursor()}`);
}

/**
 * Genesis validators have no ValidatorCreated/Initialized, so their rows and
 * the operator's initial shares are written once, before any event. Guarded by
 * a KV flag in the same transaction.
 */
async function seedGenesis(network: string) {
    if (await KV.getString(KEY_STAKING_GENESIS, '')) {
        return;
    }
    const list = GENESIS_VALIDATORS[network];
    await StakingValidator.sequelize.transaction(async dbTx => {
        for (const g of list) {
            await StakingValidator.findOrCreate({
                where: {address: g.address},
                defaults: {address: g.address, isGenesis: true, createdBlock: 0, initializedBlock: 0, operator: g.operator},
                transaction: dbTx,
            });
        }
        await applyShareDeltas(new Map(list.filter(g => g.amount != null).map(g => [pairKey(g.address, g.operator), {
            delta: BigInt(g.amount), firstBlock: 0, lastBlock: 0, firstAt: null, lastAt: null,
        }])), dbTx);
        await KV.upsert({key: KEY_STAKING_GENESIS, value: network}, {transaction: dbTx});
    });
    console.log(`staking sync: seeded ${list.length} genesis validators (${network})`);
}

async function safeHead(): Promise<number> {
    return (await ctx.provider.getBlockNumber()) - stakingOption().confirmations;
}

/**
 * Raw eth_getLogs: ethers v5's provider.getLogs() rejects an address array
 * ("invalid address or ENS name"), and the validator query needs one.
 */
async function getLogs(address: string | string[], topics: string[], from: number, to: number): Promise<RawLog[]> {
    const logs: any[] = await ctx.provider.send('eth_getLogs', [{
        address, topics: [topics], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
    }]);
    return logs.map(l => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: parseInt(l.blockNumber, 16),
        blockHash: l.blockHash,
        transactionHash: l.transactionHash,
        transactionIndex: parseInt(l.transactionIndex, 16),
        logIndex: parseInt(l.logIndex, 16),
    }));
}

function pairKey(validator: string, delegator: string) {
    return `${validator}|${delegator}`;
}

interface ShareDelta {
    delta: bigint
    firstBlock: number
    lastBlock: number
    firstAt: Date
    lastAt: Date
}

function addDelta(map: Map<string, ShareDelta>, validator: string, delegator: string,
                  delta: bigint, block: number, at: Date) {
    const k = pairKey(validator, delegator);
    const cur = map.get(k);
    if (cur) {
        cur.delta += delta;
        cur.lastBlock = block;
        cur.lastAt = at;
    } else {
        map.set(k, {delta, firstBlock: block, lastBlock: block, firstAt: at, lastAt: at});
    }
}

/** Adds deltas onto staking_delegation, creating rows as needed. */
async function applyShareDeltas(map: Map<string, ShareDelta>, dbTx: Transaction) {
    if (!map.size) {
        return;
    }
    const values = [];
    const replacements = [];
    for (const [k, d] of map) {
        const [validator, delegator] = k.split('|');
        values.push('(?,?,?,?,?,?,?)');
        replacements.push(validator, delegator, d.delta.toString(), d.firstBlock, d.lastBlock, d.firstAt, d.lastAt);
    }
    const t = StakingDelegation.getTableName();
    // assignments run left to right and see earlier ones, so lastAt goes before lastBlock
    const sql = `insert into ${t} (validator, delegator, shares, firstBlock, lastBlock, firstAt, lastAt)
        values ${values.join(',')}
        on duplicate key update shares = shares + values(shares),
            lastAt = if(values(lastBlock) >= lastBlock, values(lastAt), lastAt),
            lastBlock = greatest(lastBlock, values(lastBlock))`;
    await StakingDelegation.sequelize.query(sql, {type: QueryTypes.INSERT, replacements, transaction: dbTx});
}

/** the 0G RPCs reject the part of a JSON-RPC batch beyond 50 calls */
const BLOCK_BATCH = 50;

/**
 * Block timestamps, fetched in JSON-RPC batches: one request per block made a
 * mainnet backfill (10k event blocks) take hours.
 */
async function blockTimes(numbers: number[]): Promise<Map<number, Date>> {
    const out = new Map<number, Date>();
    for (let i = 0; i < numbers.length; i += BLOCK_BATCH) {
        const chunk = numbers.slice(i, i + BLOCK_BATCH);
        const body = chunk.map((n, id) => ({jsonrpc: '2.0', id, method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), false]}));
        for (let attempt = 0; ; attempt++) {
            try {
                const resp: any[] = await (await fetch(ConfigInstance.ether.url, {
                    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
                })).json();
                const byId = new Map(resp.map(r => [r.id, r]));
                chunk.forEach((n, id) => {
                    const r = byId.get(id);
                    if (!r?.result) {
                        throw new Error(`block ${n}: ${JSON.stringify(r?.error || 'missing')}`);
                    }
                    out.set(n, new Date(parseInt(r.result.timestamp, 16) * 1000));
                });
                break;
            } catch (e) {
                if (attempt >= 5) {
                    throw e;
                }
                await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
            }
        }
    }
    return out;
}

/** the validator's owner after `block`: the last OwnershipTransferred up to it, else the genesis operator */
async function ownerAt(validator: string, block: number, windowEvents: {log: RawLog, ev: DecodedStakingEvent}[]): Promise<string | null> {
    const inWindow = windowEvents.filter(d => d.ev.validator === validator
        && d.ev.eventType === StakingEventType.OwnershipTransferred && d.log.blockNumber <= block);
    if (inWindow.length) {
        return inWindow[inWindow.length - 1].ev.counterparty;
    }
    const last = await StakingEvent.findOne({
        raw: true, attributes: ['counterparty'], order: [['blockNumber', 'desc'], ['logIndex', 'desc']],
        where: {validator, eventType: StakingEventType.OwnershipTransferred, blockNumber: {[Op.lte]: block}},
    });
    if (last?.counterparty) {
        return last.counterparty;
    }
    return GENESIS_VALIDATORS[stakingOption().genesis]?.find(g => g.address === validator)?.operator ?? null;
}

/**
 * commission() after `block` minus before it, i.e. what the exit moved into
 * commission. Null when no node serves that state (only some behind
 * evmrpc.0g.ai keep history, hence the retries).
 */
async function commissionJump(validator: string, block: number): Promise<string | null> {
    const c = new ethers.Contract(validator, ['function commission() view returns (uint256)'], ctx.provider);
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const [before, after] = await Promise.all([c.commission({blockTag: block - 1}), c.commission({blockTag: block})]);
            return (BigInt(after.toString()) - BigInt(before.toString())).toString();
        } catch (e) {
            if (!/missing trie node|is not available|header not found/i.test(`${e?.message} ${JSON.stringify(e?.error?.body || '')}`)) {
                throw e;
            }
        }
    }
    console.log(`staking sync: no state for the exit of ${validator} at ${block}, exitSettlement left unknown`);
    return null;
}

interface WindowResult {
    events: number
    newValidators: number
}

/** Reads and applies [from, to]. Throws on RPC failure; the caller shrinks the window. */
async function syncWindow(from: number, to: number): Promise<WindowResult> {
    const opt = stakingOption();
    const stakingLogs = await getLogs(opt.contract, STAKING_TOPICS, from, to);

    // decode first: validators created in this window must be in the address
    // set before their own logs are requested
    let decoded: {log: RawLog, ev: DecodedStakingEvent}[] = [];
    const newValidators = new Set<string>();
    const decode = (log: RawLog) => {
        try {
            const ev = decodeStakingLog(log);
            if (ev) {
                decoded.push({log, ev});
            }
            return ev;
        } catch (e) {
            if (e instanceof StakingDecodeError) {
                console.log(`staking sync: skip undecodable log: ${e.message}`);
                safeAddErrorLog('staking', 'decode', e);
                return null;
            }
            throw e;
        }
    };
    for (const log of stakingLogs) {
        const ev = decode(log);
        if (ev && !ctx.validators.has(ev.validator) && (
            ev.eventType === StakingEventType.ValidatorCreated || ev.eventType === StakingEventType.ValidatorInitialized)) {
            newValidators.add(ev.validator);
        }
    }
    const addresses = [...ctx.validators, ...newValidators];
    for (let i = 0; i < addresses.length; i += ADDRESS_CHUNK) {
        const logs = await getLogs(addresses.slice(i, i + ADDRESS_CHUNK), VALIDATOR_TOPICS, from, to);
        logs.forEach(decode);
    }
    decoded.sort((a, b) => a.log.blockNumber - b.log.blockNumber || a.log.logIndex - b.log.logIndex);

    const blockTime = await blockTimes([...new Set(decoded.map(d => d.log.blockNumber))]);

    // Exits. The validator implementation changed how it exits
    // (0g-chain-ng contracts/src/staking, f61aef593): before, exit()
    // undelegated all of the owner's shares into commission() and emitted no
    // Exited; since, it leaves shares alone and emits Exited. Mainnet ran the
    // old one until shortly before block 37,392,579 (its first Exited), e.g.
    // 0x0712...f7dd at 23,630,587: commission 0 -> 565.12, owner's shares
    // 500 -> 0. So an exit without the validator's Exited in the same tx zeroes
    // the owner's shares; the amount moved, read from state when a node still
    // has it, goes into the ValidatorExited row's extra. Exited itself is not
    // stored.
    const newStyleExit = new Set(decoded.filter(d => d.ev.eventType === StakingEventType.Exited)
        .map(d => `${d.log.transactionHash}|${d.ev.validator}`));
    decoded = decoded.filter(d => d.ev.eventType !== StakingEventType.Exited);
    const exits = new Map<string, {owner: string, exitSettlement: string | null, implementation: string}>();
    for (const {log, ev} of decoded) {
        if (ev.eventType === StakingEventType.ValidatorExited) {
            const owner = await ownerAt(ev.validator, log.blockNumber, decoded);
            exits.set(`${log.blockNumber}|${log.logIndex}`, newStyleExit.has(`${log.transactionHash}|${ev.validator}`)
                ? {owner, exitSettlement: '0', implementation: 'emits-exited'}
                : {owner, exitSettlement: await commissionJump(ev.validator, log.blockNumber), implementation: 'stake-to-commission'});
        }
    }

    let inserted = 0;
    await withStakingLock(() => StakingEvent.sequelize.transaction(async dbTx => {
        // skip what an earlier (e.g. manual, overlapping) run already applied,
        // so share deltas are never counted twice
        const existing = new Set((await StakingEvent.findAll({
            attributes: ['blockNumber', 'logIndex', 'validator'], raw: true, transaction: dbTx,
            where: {blockNumber: {[Op.between]: [from, to]}, logIndex: {[Op.gte]: 0}},
        })).map(r => `${r.blockNumber}|${r.logIndex}|${r.validator}`));

        // before an upgrade, initialization also emitted a Delegate for the
        // operator in the same tx; credit the initial stake only once
        const delegatesInTx = new Set(decoded
            .filter(d => d.ev.eventType === StakingEventType.Delegate)
            .map(d => `${d.log.transactionHash}|${d.ev.validator}|${d.ev.account}`));

        const rows: IStakingEvent[] = [];
        const zeroed: {validator: string, owner: string}[] = [];
        const deltas = new Map<string, ShareDelta>();
        for (const {log, ev} of decoded) {
            if (existing.has(`${log.blockNumber}|${log.logIndex}|${ev.validator}`)) {
                continue;
            }
            const at = blockTime.get(log.blockNumber);
            rows.push({
                blockNumber: log.blockNumber, blockHash: log.blockHash, createdAt: at,
                txHash: log.transactionHash, txIndex: log.transactionIndex, logIndex: log.logIndex,
                validator: ev.validator, eventType: ev.eventType, account: ev.account, counterparty: ev.counterparty,
                amount: ev.amount, shares: ev.shares, extra: ev.extra,
            });
            switch (ev.eventType) {
                case StakingEventType.ValidatorCreated:
                    await upsertValidator(ev.validator, {createdBlock: log.blockNumber, createdAt: at}, dbTx);
                    break;
                case StakingEventType.ValidatorInitialized:
                    await upsertValidator(ev.validator, {initializedBlock: log.blockNumber, operator: ev.account}, dbTx);
                    if (!delegatesInTx.has(`${log.transactionHash}|${ev.validator}|${ev.account}`)) {
                        // the pool is empty at initialization, so shares == amount
                        addDelta(deltas, ev.validator, ev.account, BigInt(ev.amount), log.blockNumber, at);
                    }
                    break;
                case StakingEventType.ValidatorExited: {
                    await upsertValidator(ev.validator, {exitedBlock: log.blockNumber}, dbTx);
                    const exit = exits.get(`${log.blockNumber}|${log.logIndex}`);
                    rows[rows.length - 1].extra = {...(ev.extra || {}), ...exit};
                    if (exit.owner && exit.implementation === 'stake-to-commission') {
                        zeroed.push({validator: ev.validator, owner: exit.owner});
                    }
                    break;
                }
                case StakingEventType.Delegate:
                    addDelta(deltas, ev.validator, ev.account, BigInt(ev.shares), log.blockNumber, at);
                    break;
                case StakingEventType.Undelegate:
                    addDelta(deltas, ev.validator, ev.account, -BigInt(ev.shares), log.blockNumber, at);
                    break;
            }
        }
        if (rows.length) {
            await StakingEvent.bulkCreate(rows, {transaction: dbTx, ignoreDuplicates: true});
        }
        await applyShareDeltas(deltas, dbTx);
        for (const z of zeroed) {
            await StakingDelegation.update({shares: '0'}, {where: {validator: z.validator, delegator: z.owner}, transaction: dbTx});
        }
        await KV.saveNumber(KEY_STAKING_CURSOR, to, dbTx);
        inserted = rows.length;
    }));
    // only after commit, so a rolled-back window does not leave phantom entries
    newValidators.forEach(v => ctx.validators.add(v));
    return {events: inserted, newValidators: newValidators.size};
}

async function upsertValidator(address: string, fields: {[k: string]: any}, dbTx: Transaction) {
    const cols = Object.keys(fields);
    const t = StakingValidator.getTableName();
    const sql = `insert into ${t} (address, ${cols.join(', ')}) values (?, ${cols.map(() => '?').join(', ')})
        on duplicate key update ${cols.map(c => `${c} = values(${c})`).join(', ')}`;
    await StakingValidator.sequelize.query(sql, {
        type: QueryTypes.INSERT, replacements: [address, ...cols.map(c => fields[c])], transaction: dbTx,
    });
}

/** One round. Returns true when caught up with the safe head. */
export async function stakingSyncOnce(): Promise<boolean> {
    const cursor = await getStakingCursor();
    const head = await safeHead();
    if (cursor >= head) {
        return true;
    }
    const from = cursor + 1;
    const to = Math.min(head, cursor + ctx.range);
    const {events, newValidators} = await syncWindow(from, to);
    if (events || newValidators) {
        console.log(`staking sync: blocks ${from}-${to}, ${events} events, ${newValidators} new validators`);
    }
    // recover the configured window after a shrink
    ctx.range = Math.min(stakingOption().logRange, ctx.range * 2);
    return to >= head;
}

export async function runStakingSync() {
    let delay = 0;
    try {
        const caughtUp = await stakingSyncOnce();
        delay = caughtUp ? SECOND * 5 : 0;
    } catch (e) {
        // most RPC failures here are an oversized getLogs window
        ctx.range = Math.max(1, Math.floor(ctx.range / 2));
        console.log(`staking sync failed, window now ${ctx.range} blocks:`, e?.message || e);
        safeAddErrorLog('staking', 'sync', e);
        delay = SECOND * 10;
    }
    setTimeout(runStakingSync, delay);
}
