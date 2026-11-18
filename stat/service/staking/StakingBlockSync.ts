import {ethers} from "ethers";
import {Op, QueryTypes, Transaction} from "sequelize";
import {KV} from "../../model/KV";
import {
    IStakingBlockReward,
    IStakingBlockSlash,
    StakingBlockReward,
    StakingBlockSlash,
    StakingDelegation,
    StakingEvent,
    StakingEventType,
    StakingRestakingDaily,
    StakingRewardDaily,
    StakingValidator,
} from "../../model/Staking";
import {safeAddErrorLog} from "../../monitor/ErrorMonitor";
import {SECOND} from "../common/utils";
import {CommissionModel} from "./StakingCommission";
import {baselineAtStart, runChecks, StateUnavailable} from "./StakingCheck";
import {VALIDATOR_ABI} from "./StakingAbi";
import {postBatch, staticProvider, withRateRetry} from "./StakingRpc";
import {
    blockRewardOption,
    getStakingCursor,
    stakingOption,
    stakingRpcUrl,
    StrictModeWait,
    withStakingLock,
    WITHDRAWAL_ACTIVATION_BLOCK,
} from "./StakingSync";

/**
 * Per-block collection of rewards and slashes (PLAN.md "区块奖励、佣金、社区税、
 * 基金会奖励与罚没"). For each block:
 *
 *   withdrawals[0]  reward to the proposing validator's contract
 *   withdrawals[1]  restaking reward
 *   withdrawals[2]  foundation reward
 *   slashed[i]      {index: evidence height, validatorIndex, address: the
 *                    validator contract, amount}
 *
 * all amounts in gwei, the first three marked by the sentinel validatorIndex.
 * Community tax and commission are derived from withdrawals[0] the way
 * _distributeRewards splits it (see StakingCommission).
 *
 * It replaces nothing: supply still reads the consensus layer's cumulative
 * totals. Unlike the retired block_withdraws sync it runs inside token_x and
 * checks itself against those totals every round, so a stall or a drift is
 * reported rather than silent. It never runs ahead of the event sync, which
 * the commission calculation depends on.
 */

const KEY_CURSOR = 'STAKING_BLOCK_REWARD_BLOCK';
/** the consensus layer's cumulative `rewards` (gwei) at the block before the collection start */
const KEY_CL_BASE = 'STAKING_BLOCK_REWARD_CL_BASE';
const SENTINEL = '0xffffffffffffffff';
/** JSON array of withdrawals[2] recipients other than the configured foundation address */
const KEY_OTHER_FOUNDATION = 'STAKING_FOUNDATION_OTHER_ADDRESSES';
/** set once staking_restaking_daily holds everything the per-block table does */
const KEY_RESTAKING_BUILT = 'STAKING_RESTAKING_DAILY_BUILT';
const GWEI = BigInt(1e9);
const RATE_BASE = BigInt(1_000_000);
const BLOCKS_PER_ROUND = 1000;
const RPC_RETRIES = 6;

const ctx = {
    commission: null as CommissionModel,
    rounds: 0,
    /** strict mode: why the block sync stopped (a reconciliation disagreed); cleared by a restart */
    halted: null as string,
    lastHaltAlert: 0,
};

const STATE_MISSING = /missing trie node|is not available|header not found|state.*pruned/i;
let stateProvider: ethers.providers.JsonRpcProvider;

/** a historical state read; strict mode waits rather than going without it */
async function stateRead<T>(fn: () => Promise<T>, what: string): Promise<T> {
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            return await withRateRetry(fn);
        } catch (e) {
            if (!STATE_MISSING.test(`${e?.message} ${JSON.stringify(e?.error?.body || '')}`)) {
                throw e;
            }
        }
    }
    throw new StrictModeWait(`no state for ${what}; strict mode waits for an RPC that serves it`);
}

function contract(address: string, abi: string[]) {
    stateProvider = stateProvider || staticProvider(stakingRpcUrl());
    return new ethers.Contract(address, abi, stateProvider);
}

/**
 * Strict mode: setCommunityTaxRate emits nothing, and community tax is
 * computed with the configured rate, so a round is only written when the
 * chain's rate at its end (and, on the first round, before its start) is the
 * configured one. The previous round checked this round's start.
 */
async function taxRateHolds(blocks: number[]): Promise<boolean> {
    const staking = contract(stakingOption().contract, ['function communityTaxRate() view returns (uint32)']);
    for (const b of blocks) {
        const rate = BigInt((await stateRead(() => staking.communityTaxRate({blockTag: b}), `communityTaxRate() at ${b}`)).toString());
        if (rate !== blockRewardOption().communityTaxRate) {
            halt(`communityTaxRate() is ${rate} at block ${b}, configured ${blockRewardOption().communityTaxRate}; `
                + `community tax would be wrong from the change on; set blockRewards.communityTaxRate (or add a rate timeline)`);
            return false;
        }
    }
    return true;
}

interface SlashShares {
    validator: string
    blockNumber: number
    logIndex: number
    operator: string
    /** shares the slash took from the operator (owner), as a positive number */
    taken: bigint
}

/**
 * Strict mode: a consensus-layer slash is a system call, so the shares it
 * takes from the owner leave no event. Outside strict mode the refresher
 * notices the gap and overwrites the row with the chain's value; strict mode
 * instead accounts for it here, at the slash's own block: the owner's shares
 * after the block minus before it, less the owner's own Delegate/Undelegate in
 * that block, is what the slash took. Needs historical state.
 */
async function slashedShares(slashes: IStakingBlockSlash[]): Promise<SlashShares[]> {
    const out: SlashShares[] = [];
    const seen = new Set<string>();
    for (const s of slashes) {
        // several entries for one validator in one block: one state difference covers them
        const key = `${s.validator}|${s.blockNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const c = contract(s.validator, VALIDATOR_ABI);
        const b = s.blockNumber;
        const operator = String(await stateRead(() => c.operatorAddress({blockTag: b}), `the operator of ${s.validator} at ${b}`)).toLowerCase();
        const [[, before], [, after]] = await stateRead(() => Promise.all([
            c.getDelegation(operator, {blockTag: b - 1}), c.getDelegation(operator, {blockTag: b}),
        ]), `the operator's shares of ${s.validator} at ${b - 1} and ${b}`);
        const [own]: any[] = await StakingEvent.sequelize.query(
            `select cast(coalesce(sum(case when eventType = ? then shares else -shares end), 0) as char) as d
             from ${StakingEvent.getTableName()} where validator = ? and account = ? and blockNumber = ? and eventType in (?, ?)`,
            {type: QueryTypes.SELECT, replacements: [StakingEventType.Delegate, s.validator, operator, b, StakingEventType.Delegate, StakingEventType.Undelegate]});
        const taken = BigInt(before.toString()) + BigInt(own.d) - BigInt(after.toString());
        out.push({validator: s.validator, blockNumber: b, logIndex: -1 - s.position, operator, taken});
    }
    return out;
}

/** writes each slash's share change once (keyed by its SlashDetected row) */
async function applySlashedShares(changes: SlashShares[], createdAt: Map<number, Date>, dbTx: Transaction) {
    for (const ch of changes) {
        const [, created] = await StakingEvent.findOrCreate({
            where: {blockNumber: ch.blockNumber, logIndex: ch.logIndex, validator: ch.validator},
            defaults: {
                blockNumber: ch.blockNumber, blockHash: '', createdAt: createdAt.get(ch.blockNumber), txHash: '', txIndex: -1,
                logIndex: ch.logIndex, validator: ch.validator, eventType: StakingEventType.SlashDetected,
                account: ch.operator, shares: ch.taken.toString(), extra: {source: 'block-slash'},
            },
            transaction: dbTx,
        });
        if (created && ch.taken !== BigInt(0)) {
            await StakingDelegation.sequelize.query(
                `update ${StakingDelegation.getTableName()} set shares = shares - ? where validator = ? and delegator = ?`,
                {type: QueryTypes.UPDATE, replacements: [ch.taken.toString(), ch.validator, ch.operator], transaction: dbTx});
        }
    }
}

function halt(reason: string) {
    ctx.halted = reason;
    ctx.lastHaltAlert = Date.now();
    const msg = `block sync stopped (strict mode): ${reason}. Restart token_x once the cause is found.`;
    console.log(`staking blocks: ${msg}`);
    safeAddErrorLog('staking', 'halted', new Error(msg));
}

/** withdrawals[2] recipients seen other than the configured foundation address; normally empty */
export async function otherFoundationAddresses(transaction?: Transaction): Promise<string[]> {
    const row = await KV.findByPk(KEY_OTHER_FOUNDATION, {raw: true, transaction});
    return row?.value ? JSON.parse(row.value) : [];
}

export async function getBlockRewardCursor(): Promise<number> {
    return (await KV.getNumber(KEY_CURSOR)) ?? blockRewardOption().startBlock - 1;
}

/** rate-limit rejections are retried inside postBatch; this retries the rest (dropped connections, a lagging node) */
async function rpcBatch(calls: {method: string, params: any[]}[]): Promise<any[]> {
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await postBatch(stakingRpcUrl(), calls);
            const failed = res.find(r => r.error);
            if (failed) {
                throw new Error(`rpc error: ${JSON.stringify(failed.error)}`);
            }
            return res.map(r => r.result);
        } catch (e) {
            if (attempt >= RPC_RETRIES) {
                throw e;
            }
            await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
        }
    }
}

async function fetchBlocks(from: number, to: number): Promise<any[]> {
    const {batchSize, concurrency} = blockRewardOption();
    const ranges: [number, number][] = [];
    for (let a = from; a <= to; a += batchSize) {
        ranges.push([a, Math.min(to, a + batchSize - 1)]);
    }
    const out: any[] = [];
    for (let i = 0; i < ranges.length; i += concurrency) {
        const parts = await Promise.all(ranges.slice(i, i + concurrency).map(([a, b]) => rpcBatch(
            Array.from({length: b - a + 1}, (_, k) => ({method: 'eth_getBlockByNumber', params: ['0x' + (a + k).toString(16), false]})))));
        parts.forEach(p => out.push(...p));
    }
    return out;
}

/** the consensus layer's cumulative rewards (gwei) at `block`; 0 before withdrawals began */
async function clRewards(block: number): Promise<bigint | null> {
    const url = blockRewardOption().clTotalWithdrawalsUrl;
    if (!/\/blocks\/[^/]+\/total_withdrawals\/?$/.test(url)) {
        return null;
    }
    const resp = await fetch(url.replace(/\/blocks\/[^/]+\/total_withdrawals\/?$/, `/blocks/${block}/total_withdrawals`));
    const json: any = await resp.json();
    if (json?.data?.rewards != null) {
        return BigInt(json.data.rewards);
    }
    if (json?.code === 404 && block < WITHDRAWAL_ACTIVATION_BLOCK) {
        return BigInt(0);
    }
    throw new Error(`consensus layer total_withdrawals at ${block}: ${JSON.stringify(json).slice(0, 200)}`);
}

interface Parsed {
    reward: IStakingBlockReward | null
    slashes: IStakingBlockSlash[]
    /** the block has no reward row although withdrawals should be there */
    unparsed?: boolean
    /** withdrawals[2].address when it is not the configured foundation address */
    otherFoundation?: string
}

function parseBlock(b: any, warn: (msg: string) => void): Parsed {
    const number = parseInt(b.number, 16);
    const createdAt = new Date(parseInt(b.timestamp, 16) * 1000);
    const w: any[] = b.withdrawals || [];
    let reward: IStakingBlockReward = null;
    let otherFoundation: string;
    if (w.length) {
        if (w.length < 3 || !w.slice(0, 3).every(x => x.validatorIndex === SENTINEL)) {
            warn(`block ${number}: first three withdrawals are not all rewards, not parsed`);
        } else {
            const foundationAddress = w[2].address.toLowerCase();
            if (foundationAddress !== blockRewardOption().foundationAddress) {
                warn(`block ${number}: withdrawals[2] goes to ${foundationAddress}, not the configured foundation address`);
                otherFoundation = foundationAddress;
            }
            reward = {
                blockNumber: number, createdAt,
                validator: w[0].address.toLowerCase(),
                reward: (BigInt(w[0].amount) * GWEI).toString(),
                communityTax: '0', commission: '0',
                restakingAddress: w[1].address.toLowerCase(),
                restakingReward: (BigInt(w[1].amount) * GWEI).toString(),
                foundationReward: (BigInt(w[2].amount) * GWEI).toString(),
            };
        }
    }
    // position is the index in the block's array, kept even when an entry is
    // skipped so a row can be traced back to the RPC response
    const slashes = (b.slashed || []).map((s: any, position: number) => ({
        blockNumber: number, createdAt, position,
        slashIndex: BigInt(s.index).toString(),
        validatorIndex: BigInt(s.validatorIndex).toString(),
        validator: s.address.toLowerCase(),
        amount: (BigInt(s.amount) * GWEI).toString(),
    })).filter((s: IStakingBlockSlash) => {
        // 0g-geth's ProcessStakingSlashings skips zero amounts without calling slashValidator
        if (s.amount === '0') {
            warn(`block ${number}: slashed[${s.position}] has amount 0, skipped as the chain does`);
            return false;
        }
        return true;
    });
    return {reward, slashes, otherFoundation, unparsed: reward == null && number >= WITHDRAWAL_ACTIVATION_BLOCK};
}

type Daily = {blockCount: number, reward: bigint, communityTax: bigint, commission: bigint,
    restakingReward: bigint, foundationReward: bigint, slashCount: number, slashedAmount: bigint};

function dailyOf(map: Map<string, Daily>, day: string, validator: string): Daily {
    const k = `${day}|${validator}`;
    return map.get(k) || map.set(k, {
        blockCount: 0, reward: BigInt(0), communityTax: BigInt(0), commission: BigInt(0),
        restakingReward: BigInt(0), foundationReward: BigInt(0), slashCount: 0, slashedAmount: BigInt(0),
    }).get(k);
}

async function addDaily(map: Map<string, Daily>, dbTx: Transaction) {
    if (!map.size) {
        return;
    }
    const cols = ['blockCount', 'reward', 'communityTax', 'commission', 'restakingReward', 'foundationReward', 'slashCount', 'slashedAmount'];
    const values = [], replacements = [];
    for (const [k, d] of map) {
        const [day, validator] = k.split('|');
        values.push(`(?,?,${cols.map(() => '?').join(',')})`);
        replacements.push(day, validator, ...cols.map(c => d[c].toString()));
    }
    await StakingRewardDaily.sequelize.query(
        `insert into ${StakingRewardDaily.getTableName()} (day, validator, ${cols.join(', ')}) values ${values.join(',')}
         on duplicate key update ${cols.map(c => `${c} = ${c} + values(${c})`).join(', ')}`,
        {type: QueryTypes.INSERT, replacements, transaction: dbTx});
}

async function addRestakingDaily(map: Map<string, {blockCount: number, amount: bigint}>, dbTx: Transaction) {
    if (!map.size) {
        return;
    }
    const values = [], replacements = [];
    for (const [k, d] of map) {
        const [day, address] = k.split('|');
        values.push('(?,?,?,?)');
        replacements.push(day, address, d.blockCount, d.amount.toString());
    }
    await StakingRestakingDaily.sequelize.query(
        `insert into ${StakingRestakingDaily.getTableName()} (day, address, blockCount, amount) values ${values.join(',')}
         on duplicate key update blockCount = blockCount + values(blockCount), amount = amount + values(amount)`,
        {type: QueryTypes.INSERT, replacements, transaction: dbTx});
}

/**
 * staking_restaking_daily came after staking_block_reward, so a deployment
 * that already collected blocks gets it built from them once; from then on
 * each round adds to it in the same transaction as its blocks.
 */
async function buildRestakingDaily() {
    if (await KV.getString(KEY_RESTAKING_BUILT, '')) {
        return;
    }
    await StakingBlockReward.sequelize.transaction(async dbTx => {
        await StakingRestakingDaily.destroy({where: {}, transaction: dbTx});
        await StakingRestakingDaily.sequelize.query(
            `insert into ${StakingRestakingDaily.getTableName()} (day, address, blockCount, amount)
             select date(createdAt), restakingAddress, count(*), sum(restakingReward)
             from ${StakingBlockReward.getTableName()} where restakingReward > 0
             group by date(createdAt), restakingAddress`,
            {type: QueryTypes.INSERT, transaction: dbTx});
        await KV.upsert({key: KEY_RESTAKING_BUILT, value: new Date().toISOString()}, {transaction: dbTx});
    });
    console.log(`staking blocks: built staking_restaking_daily from the collected blocks`);
}

/** One round. Returns true when caught up with the event sync. */
export async function stakingBlockSyncOnce(): Promise<boolean> {
    const opt = blockRewardOption();
    const strict = stakingOption().strict;
    await buildRestakingDaily();
    const cursor = await getBlockRewardCursor();
    if (await KV.getString(KEY_CL_BASE, '') === '') {
        const base = await clRewards(opt.startBlock - 1).catch(e => {
            console.log(`staking blocks: no consensus layer baseline:`, e?.message || e);
            return null;
        });
        if (base == null && strict) {
            throw new StrictModeWait(`no consensus-layer baseline at ${opt.startBlock - 1} (blockRewards.clTotalWithdrawalsUrl / validatorRpc); strict mode does not run without the reconciliation`);
        }
        if (base == null) {
            console.log(`staking blocks: reconciliation off`);
        }
        await KV.upsert({key: KEY_CL_BASE, value: base == null ? 'none' : base.toString()});
    }
    if (cursor === opt.startBlock - 1) {
        // nothing collected yet: anchor the commission checkpoints before the first block
        try {
            await baselineAtStart();
        } catch (e) {
            if (strict && e instanceof StateUnavailable) {
                throw new StrictModeWait(`no state at ${opt.startBlock - 1} for the first commission checkpoint; strict mode waits for an RPC that serves it`);
            }
            console.log(`staking blocks: no commission baseline before ${opt.startBlock}, the first checkpoint after the first round is:`, e?.message || e);
        }
    }
    // never ahead of the events the commission calculation reads
    const head = await getStakingCursor();
    if (cursor >= head) {
        return true;
    }
    const from = cursor + 1, to = Math.min(head, cursor + BLOCKS_PER_ROUND);
    const blocks = await fetchBlocks(from, to);
    if (blocks.some(b => !b)) {
        throw new Error(`missing block in ${from}-${to}`);
    }

    const warnings: string[] = [];
    const parsed = blocks.map(b => parseBlock(b, m => warnings.push(m)));
    if (strict && parsed.some(p => p.unparsed)) {
        const n = from + parsed.findIndex(p => p.unparsed);
        halt(`block ${n} has no parseable rewards (${warnings[0] || 'no withdrawals'})`);
        return false;
    }
    const slashed = [...new Set(parsed.flatMap(p => p.slashes.map(s => s.validator)))];
    if (slashed.length) {
        // slashValidator is a no-op for an address that is not a registered validator
        const known = new Set((await StakingValidator.findAll({
            raw: true, attributes: ['address'], where: {address: {[Op.in]: slashed}},
        })).map(v => v.address));
        slashed.filter(v => !known.has(v)).forEach(v => warnings.push(`slashed address ${v} is not a known validator`));
    }
    warnings.slice(0, 5).forEach(m => console.log(`staking blocks: ${m}`));
    if (warnings.length) {
        safeAddErrorLog('staking', 'block-parse', new Error(`${warnings.length} warnings in ${from}-${to}, first: ${warnings[0]}`));
    }

    if (!ctx.commission) {
        ctx.commission = new CommissionModel(opt.startBlock);
    }
    const proposers = new Set(parsed.filter(p => p.reward).map(p => p.reward.validator));
    await ctx.commission.prepare(proposers, to, parsed.flatMap(p => p.slashes));

    const rewards: IStakingBlockReward[] = [];
    const slashes: IStakingBlockSlash[] = [];
    const daily = new Map<string, Daily>();
    const restaking = new Map<string, {blockCount: number, amount: bigint}>();
    for (const {reward: r, slashes: ss} of parsed) {
        if (r && BigInt(r.restakingReward) > BigInt(0)) {
            const k = `${r.createdAt.toISOString().slice(0, 10)}|${r.restakingAddress}`;
            const d = restaking.get(k) || restaking.set(k, {blockCount: 0, amount: BigInt(0)}).get(k);
            d.blockCount++;
            d.amount += BigInt(r.restakingReward);
        }
        if (r) {
            const reward = BigInt(r.reward);
            const tax = reward * opt.communityTaxRate / RATE_BASE;
            const commission = ctx.commission.qualifiedAt(r.validator, r.blockNumber)
                ? reward * ctx.commission.rateAt(r.validator, r.blockNumber) / RATE_BASE : BigInt(0);
            r.communityTax = tax.toString();
            r.commission = commission.toString();
            rewards.push(r);
            const d = dailyOf(daily, r.createdAt.toISOString().slice(0, 10), r.validator);
            d.blockCount++;
            d.reward += reward;
            d.communityTax += tax;
            d.commission += commission;
            d.restakingReward += BigInt(r.restakingReward);
            d.foundationReward += BigInt(r.foundationReward);
        }
        for (const s of ss) {
            slashes.push(s);
            const d = dailyOf(daily, s.createdAt.toISOString().slice(0, 10), s.validator);
            d.slashCount++;
            d.slashedAmount += BigInt(s.amount);
        }
    }

    // strict mode: no round is written under a tax rate other than the configured one,
    // and the shares a slash took are accounted for at its block
    if (strict && !await taxRateHolds(cursor === opt.startBlock - 1 ? [cursor, to] : [to])) {
        return false;
    }
    const slashShares = strict && slashes.length ? await slashedShares(slashes) : [];
    const blockTimeOf = new Map(slashes.map(s => [s.blockNumber, s.createdAt]));

    // the share update for slashes runs under the event sync's lock: both write staking_delegation
    const write = () => StakingBlockReward.sequelize.transaction(async dbTx => {
        // a window applied before (e.g. a manual rerun) must not be added to the daily totals twice
        const done = await StakingBlockReward.count({where: {blockNumber: {[Op.between]: [from, to]}}, transaction: dbTx});
        if (done) {
            throw new Error(`blocks ${from}-${to} already have ${done} rows; the cursor is behind the data`);
        }
        if (rewards.length) await StakingBlockReward.bulkCreate(rewards, {transaction: dbTx});
        if (slashes.length) await StakingBlockSlash.bulkCreate(slashes, {transaction: dbTx});
        await addDaily(daily, dbTx);
        await addRestakingDaily(restaking, dbTx);
        const others = parsed.map(p => p.otherFoundation).filter(Boolean);
        if (others.length) {
            const seen = await otherFoundationAddresses(dbTx);
            const merged = [...new Set([...seen, ...others])];
            if (merged.length > seen.length) {
                await KV.upsert({key: KEY_OTHER_FOUNDATION, value: JSON.stringify(merged)}, {transaction: dbTx});
            }
        }
        await applySlashedShares(slashShares, blockTimeOf, dbTx);
        await KV.saveNumber(KEY_CURSOR, to, dbTx);
    });
    await (slashShares.length ? withStakingLock(write) : write());
    if (slashes.length) {
        console.log(`staking blocks: ${slashes.length} slashes in ${from}-${to}`
            + (slashShares.length ? `, shares taken: ${slashShares.map(x => `${x.validator} ${x.taken}`).join(', ')}` : ''));
    }
    return to >= head;
}

/**
 * Rewards + restaking + foundation collected so far must equal the consensus
 * layer's cumulative rewards over the same blocks, exactly.
 */
export async function reconcileBlockRewards(): Promise<{ok: boolean, message: string} | null> {
    const base = await KV.getString(KEY_CL_BASE, '');
    if (base === '' || base === 'none') {
        return null;
    }
    const cursor = await getBlockRewardCursor();
    const cl = await clRewards(cursor);
    if (cl == null) {
        return null;
    }
    const [sum]: any[] = await StakingRewardDaily.sequelize.query(
        `select cast(coalesce(sum(reward + restakingReward + foundationReward), 0) as char) as total
         from ${StakingRewardDaily.getTableName()}`, {type: QueryTypes.SELECT});
    const ours = BigInt(sum.total) / GWEI;
    const expected = cl - BigInt(base);
    const ok = ours === expected;
    const message = `blocks ${blockRewardOption().startBlock}-${cursor}: collected ${ours} gwei, consensus layer ${expected} gwei`;
    if (!ok) {
        safeAddErrorLog('staking', 'block-reconcile', new Error(message));
    }
    return {ok, message};
}

export async function runStakingBlockSync() {
    const strict = stakingOption().strict;
    let delay = 0;
    try {
        if (ctx.halted) {
            if (Date.now() - ctx.lastHaltAlert > 10 * 60 * SECOND) {
                halt(ctx.halted);
            }
            delay = 60 * SECOND;
        } else {
            const caughtUp = await stakingBlockSyncOnce();
            const cursor = await getBlockRewardCursor();
            const check = await runChecks(cursor, caughtUp);
            if (strict && check?.mismatches.length) {
                const m = check.mismatches[0];
                halt(`commission checkpoint at ${check.block} disagrees for ${check.mismatches.length} validator(s), first ${m.validator}: `
                    + `chain ${m.actual}, collected ${m.expected}; check-commission ${m.validator} ${m.prevBlock + 1} ${check.block}`);
            }
            // strict mode reconciles every round, so a drift stops the sync where it starts
            if (!ctx.halted && (strict || caughtUp || ++ctx.rounds % 100 === 0)) {
                const r = await reconcileBlockRewards().catch(e => {
                    console.log(`staking blocks: reconciliation not run:`, e?.message || e);
                    return null;
                });
                if (r && !r.ok) {
                    console.log(`staking blocks: reconciliation failed, ${r.message}`);
                    if (strict) halt(`consensus-layer reconciliation: ${r.message}`);
                }
            }
            delay = caughtUp ? 5 * SECOND : 0;
        }
    } catch (e) {
        if (e instanceof StrictModeWait) {
            console.log(`staking blocks: ${e.message}`);
            safeAddErrorLog('staking', 'strict', e);
            delay = 60 * SECOND;
        } else {
            console.log(`staking blocks failed:`, e?.message || e);
            safeAddErrorLog('staking', 'blocks', e);
            delay = 10 * SECOND;
        }
    }
    setTimeout(runStakingBlockSync, delay);
}
