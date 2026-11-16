import {Op, QueryTypes, Transaction} from "sequelize";
import {ConfigInstance} from "../../config/StatConfig";
import {KV} from "../../model/KV";
import {
    IStakingBlockReward,
    IStakingBlockSlash,
    StakingBlockReward,
    StakingBlockSlash,
    StakingRewardDaily,
    StakingValidator,
} from "../../model/Staking";
import {safeAddErrorLog} from "../../monitor/ErrorMonitor";
import {SECOND} from "../common/utils";
import {CommissionModel} from "./StakingCommission";
import {runChecks} from "./StakingCheck";
import {blockRewardOption, getStakingCursor, WITHDRAWAL_ACTIVATION_BLOCK} from "./StakingSync";

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
const GWEI = BigInt(1e9);
const RATE_BASE = BigInt(1_000_000);
const BLOCKS_PER_ROUND = 1000;
const RPC_RETRIES = 6;

const ctx = {
    commission: null as CommissionModel,
    rounds: 0,
};

/** withdrawals[2] recipients seen other than the configured foundation address; normally empty */
export async function otherFoundationAddresses(transaction?: Transaction): Promise<string[]> {
    const row = await KV.findByPk(KEY_OTHER_FOUNDATION, {raw: true, transaction});
    return row?.value ? JSON.parse(row.value) : [];
}

export async function getBlockRewardCursor(): Promise<number> {
    return (await KV.getNumber(KEY_CURSOR)) ?? blockRewardOption().startBlock - 1;
}

async function rpcBatch(calls: {method: string, params: any[]}[]): Promise<any[]> {
    const body = calls.map((c, id) => ({jsonrpc: '2.0', id, ...c}));
    for (let attempt = 0; ; attempt++) {
        try {
            const resp = await fetch(ConfigInstance.ether.url, {
                method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
            });
            const json: any[] = await resp.json();
            const byId = new Map(json.map(r => [r.id, r]));
            const failed = json.find(r => r.error);
            if (failed) {
                throw new Error(`rpc error: ${JSON.stringify(failed.error)}`);
            }
            return calls.map((_, id) => byId.get(id)?.result);
        } catch (e) {
            if (attempt >= RPC_RETRIES) {
                throw e;
            }
            // mostly -32005 "request rate exceeded" or a dropped connection
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
    return {reward, slashes, otherFoundation};
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

/** One round. Returns true when caught up with the event sync. */
export async function stakingBlockSyncOnce(): Promise<boolean> {
    const opt = blockRewardOption();
    const cursor = await getBlockRewardCursor();
    if (await KV.getString(KEY_CL_BASE, '') === '') {
        const base = await clRewards(opt.startBlock - 1).catch(e => {
            console.log(`staking blocks: no consensus layer baseline, reconciliation off:`, e?.message || e);
            return null;
        });
        await KV.upsert({key: KEY_CL_BASE, value: base == null ? 'none' : base.toString()});
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
    for (const {reward: r, slashes: ss} of parsed) {
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

    await StakingBlockReward.sequelize.transaction(async dbTx => {
        // a window applied before (e.g. a manual rerun) must not be added to the daily totals twice
        const done = await StakingBlockReward.count({where: {blockNumber: {[Op.between]: [from, to]}}, transaction: dbTx});
        if (done) {
            throw new Error(`blocks ${from}-${to} already have ${done} rows; the cursor is behind the data`);
        }
        if (rewards.length) await StakingBlockReward.bulkCreate(rewards, {transaction: dbTx});
        if (slashes.length) await StakingBlockSlash.bulkCreate(slashes, {transaction: dbTx});
        await addDaily(daily, dbTx);
        const others = parsed.map(p => p.otherFoundation).filter(Boolean);
        if (others.length) {
            const seen = await otherFoundationAddresses(dbTx);
            const merged = [...new Set([...seen, ...others])];
            if (merged.length > seen.length) {
                await KV.upsert({key: KEY_OTHER_FOUNDATION, value: JSON.stringify(merged)}, {transaction: dbTx});
            }
        }
        await KV.saveNumber(KEY_CURSOR, to, dbTx);
    });
    if (slashes.length) {
        console.log(`staking blocks: ${slashes.length} slashes in ${from}-${to}`);
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
    let delay = 0;
    try {
        const caughtUp = await stakingBlockSyncOnce();
        await runChecks(await getBlockRewardCursor(), caughtUp);
        if (caughtUp || ++ctx.rounds % 100 === 0) {
            const r = await reconcileBlockRewards().catch(e => ({ok: false, message: e?.message || String(e)}));
            if (r && !r.ok) {
                console.log(`staking blocks: reconciliation failed, ${r.message}`);
            }
        }
        delay = caughtUp ? 5 * SECOND : 0;
    } catch (e) {
        console.log(`staking blocks failed:`, e?.message || e);
        safeAddErrorLog('staking', 'blocks', e);
        delay = 10 * SECOND;
    }
    setTimeout(runStakingBlockSync, delay);
}
