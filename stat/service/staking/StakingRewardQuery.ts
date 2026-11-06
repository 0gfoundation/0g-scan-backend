import {ethers} from "ethers";
import {Op, QueryTypes} from "sequelize";
import {ConfigInstance} from "../../config/StatConfig";
import {KV} from "../../model/KV";
import {StakingBlockReward, StakingBlockSlash, StakingRewardDaily, StakingValidator} from "../../model/Staking";
import {blockRewardOption, stakingOption} from "./StakingSync";

/**
 * Read side of the per-block collection: validator rewards / commission /
 * slashes, community tax and foundation rewards, cumulative or over a time
 * range. Amounts are wei integer strings.
 *
 * Cumulative figures sum staking_reward_daily and count from the collection
 * start (`startBlock` in each response), up to `asOfBlock`. A range
 * [start, end) takes whole UTC days from staking_reward_daily and the partial
 * days at either end from the per-block tables, so arbitrary second-level
 * bounds stay exact without scanning millions of rows.
 */

const ZERO = BigInt(0);
const DAY = 86400_000;

export interface Totals {
    blockCount: number
    reward: bigint
    communityTax: bigint
    commission: bigint
    restakingReward: bigint
    foundationReward: bigint
    slashCount: number
    slashedAmount: bigint
}

const empty = (): Totals => ({
    blockCount: 0, reward: ZERO, communityTax: ZERO, commission: ZERO,
    restakingReward: ZERO, foundationReward: ZERO, slashCount: 0, slashedAmount: ZERO,
});

function add(a: Totals, b: Partial<Totals>): Totals {
    return {
        blockCount: a.blockCount + (b.blockCount ?? 0),
        reward: a.reward + (b.reward ?? ZERO),
        communityTax: a.communityTax + (b.communityTax ?? ZERO),
        commission: a.commission + (b.commission ?? ZERO),
        restakingReward: a.restakingReward + (b.restakingReward ?? ZERO),
        foundationReward: a.foundationReward + (b.foundationReward ?? ZERO),
        slashCount: a.slashCount + (b.slashCount ?? 0),
        slashedAmount: a.slashedAmount + (b.slashedAmount ?? ZERO),
    };
}

/** the validator-facing fields; delegatorReward is what is left for the pool */
export function formatValidatorTotals(t: Totals) {
    return {
        blockCount: t.blockCount,
        reward: t.reward.toString(),
        communityTax: t.communityTax.toString(),
        commission: t.commission.toString(),
        delegatorReward: (t.reward - t.communityTax - t.commission).toString(),
        slashCount: t.slashCount,
        slashedAmount: t.slashedAmount.toString(),
    };
}

const big = (v: any) => BigInt(v ?? 0);
const checksum = (a: string) => a ? ethers.utils.getAddress(a) : a;
const midnight = (t: number) => Math.floor(t / DAY) * DAY;

type Grouped = Map<string, Totals>;

function merge(into: Grouped, key: string, t: Partial<Totals>) {
    into.set(key, add(into.get(key) || empty(), t));
}

const SUM_COLS = `count(*) as blockCount, cast(sum(reward) as char) as reward,
    cast(sum(communityTax) as char) as communityTax, cast(sum(commission) as char) as commission,
    cast(sum(restakingReward) as char) as restakingReward, cast(sum(foundationReward) as char) as foundationReward`;

const fromRow = (r: any): Partial<Totals> => ({
    blockCount: Number(r.blockCount ?? 0), reward: big(r.reward), communityTax: big(r.communityTax),
    commission: big(r.commission), restakingReward: big(r.restakingReward), foundationReward: big(r.foundationReward),
    slashCount: Number(r.slashCount ?? 0), slashedAmount: big(r.slashedAmount),
});

/**
 * Totals grouped by `groupBy` ('validator' or 'day'), over whole days
 * [dayFrom, dayTo) from the daily table.
 */
async function fromDaily(groupBy: 'validator' | 'day', validator: string | undefined, dayFrom?: number, dayTo?: number): Promise<Grouped> {
    const cond = [], replacements = [];
    if (validator) { cond.push('validator = ?'); replacements.push(validator); }
    if (dayFrom != null) { cond.push('day >= ?'); replacements.push(new Date(dayFrom).toISOString().slice(0, 10)); }
    if (dayTo != null) { cond.push('day < ?'); replacements.push(new Date(dayTo).toISOString().slice(0, 10)); }
    const key = groupBy === 'day' ? `date_format(day, '%Y-%m-%d')` : 'validator';
    const rows: any[] = await StakingRewardDaily.sequelize.query(
        `select ${key} as k, cast(sum(blockCount) as char) as blockCount, cast(sum(reward) as char) as reward,
                cast(sum(communityTax) as char) as communityTax, cast(sum(commission) as char) as commission,
                cast(sum(restakingReward) as char) as restakingReward, cast(sum(foundationReward) as char) as foundationReward,
                cast(sum(slashCount) as char) as slashCount, cast(sum(slashedAmount) as char) as slashedAmount
         from ${StakingRewardDaily.getTableName()} ${cond.length ? 'where ' + cond.join(' and ') : ''} group by k`,
        {type: QueryTypes.SELECT, replacements});
    const out: Grouped = new Map();
    rows.forEach(r => merge(out, r.k, fromRow(r)));
    return out;
}

/** Totals grouped by `groupBy` over [from, to) from the per-block tables. */
async function fromBlocks(groupBy: 'validator' | 'day', validator: string | undefined, from: number, to: number): Promise<Grouped> {
    const out: Grouped = new Map();
    if (from >= to) {
        return out;
    }
    const key = groupBy === 'day' ? `date_format(createdAt, '%Y-%m-%d')` : 'validator';
    const cond = `createdAt >= ? and createdAt < ?${validator ? ' and validator = ?' : ''}`;
    const replacements = [new Date(from), new Date(to), ...(validator ? [validator] : [])];
    const [rewards, slashes]: any[][] = await Promise.all([
        StakingBlockReward.sequelize.query(
            `select ${key} as k, ${SUM_COLS} from ${StakingBlockReward.getTableName()} where ${cond} group by k`,
            {type: QueryTypes.SELECT, replacements}),
        StakingBlockSlash.sequelize.query(
            `select ${key} as k, count(*) as slashCount, cast(sum(amount) as char) as slashedAmount
             from ${StakingBlockSlash.getTableName()} where ${cond} group by k`,
            {type: QueryTypes.SELECT, replacements}),
    ]);
    rewards.forEach(r => merge(out, r.k, fromRow(r)));
    slashes.forEach(r => merge(out, r.k, {slashCount: Number(r.slashCount), slashedAmount: big(r.slashedAmount)}));
    return out;
}

/** [from, to) split into whole days from the daily table and partial days from the block tables */
async function rangeGrouped(groupBy: 'validator' | 'day', validator: string | undefined, from: number, to: number): Promise<Grouped> {
    const firstDay = midnight(from) === from ? from : midnight(from) + DAY;
    const lastDay = midnight(to);
    if (firstDay >= lastDay) {
        return fromBlocks(groupBy, validator, from, to);
    }
    const parts = await Promise.all([
        fromDaily(groupBy, validator, firstDay, lastDay),
        fromBlocks(groupBy, validator, from, firstDay),
        fromBlocks(groupBy, validator, lastDay, to),
    ]);
    const out: Grouped = new Map();
    parts.forEach(p => p.forEach((t, k) => merge(out, k, t)));
    return out;
}

const total = (g: Grouped) => [...g.values()].reduce((s, t) => add(s, t), empty());

export async function asOf() {
    const cursor = await KV.getNumber('STAKING_BLOCK_REWARD_BLOCK');
    const last = cursor == null ? null : await StakingBlockReward.findOne({
        raw: true, attributes: ['blockNumber', 'createdAt'], order: [['blockNumber', 'desc']],
    });
    return {
        startBlock: blockRewardOption().startBlock,
        asOfBlock: cursor,
        asOfTime: last ? Math.floor(new Date(last.createdAt).getTime() / 1000) : null,
    };
}

/** cumulative totals per validator, for /validators and /validator */
export async function cumulativeByValidator(validator?: string): Promise<Grouped> {
    return fromDaily('validator', validator);
}

interface RangeOpt {
    start?: Date
    end?: Date
    interval?: 'day'
}

/** clamps the range to collected data; null when no range was asked for */
async function resolveRange(opt: RangeOpt, asOfTime: number | null) {
    if (!opt.start) {
        return null;
    }
    const from = opt.start.getTime();
    const requestedTo = (opt.end ?? new Date()).getTime();
    const limit = asOfTime == null ? from : (asOfTime + 1) * 1000;
    return {from, to: Math.min(requestedTo, limit), truncated: requestedTo > limit};
}

function rangeHeader(r: {from: number, to: number, truncated: boolean}) {
    return {start: r.from / 1000, end: r.to / 1000, ...(r.truncated ? {truncatedToAsOf: true} : {})};
}

export type RewardSort = 'reward' | 'commission' | 'blockCount' | 'slashedAmount';

/** (1) validator rewards, commission and slashes */
export async function getValidatorRewards(opt: RangeOpt & {validator?: string, sort?: RewardSort}) {
    const head = await asOf();
    const range = await resolveRange(opt, head.asOfTime);
    const cumulative = await fromDaily('validator', opt.validator);
    const inRange = range ? await rangeGrouped('validator', opt.validator, range.from, range.to) : null;
    const list = range && opt.interval === 'day' ? await rangeGrouped('day', opt.validator, range.from, range.to) : null;
    const rangeBody = range ? {
        ...rangeHeader(range), ...formatValidatorTotals(total(inRange)),
        ...(list ? {list: [...list].sort(([a], [b]) => a.localeCompare(b)).map(([date, t]) => ({date, ...formatValidatorTotals(t)}))} : {}),
    } : undefined;

    if (opt.validator) {
        const v = await StakingValidator.findOne({raw: true, attributes: ['moniker'], where: {address: opt.validator}});
        return {
            validator: checksum(opt.validator), moniker: v?.moniker ?? null, ...head,
            cumulative: formatValidatorTotals(cumulative.get(opt.validator) || empty()),
            ...(rangeBody ? {range: rangeBody} : {}),
        };
    }
    const monikers = new Map((await StakingValidator.findAll({raw: true, attributes: ['address', 'moniker']})).map(v => [v.address, v.moniker]));
    const per = inRange || cumulative;
    const key: {[k in RewardSort]: (t: Totals) => bigint} = {
        reward: t => t.reward, commission: t => t.commission,
        blockCount: t => BigInt(t.blockCount), slashedAmount: t => t.slashedAmount,
    };
    const k = key[opt.sort || 'reward'];
    const validators = [...per].sort(([, a], [, b]) => {
        const d = k(b) - k(a);
        return d > ZERO ? 1 : d < ZERO ? -1 : 0;
    }).map(([address, t]) => ({validator: checksum(address), moniker: monikers.get(address) ?? null, ...formatValidatorTotals(t)}));
    return {
        ...head,
        cumulative: formatValidatorTotals(total(cumulative)),
        ...(rangeBody ? {range: rangeBody} : {}),
        validators,
    };
}

let communityPool: string = null;
async function communityPoolAddress(): Promise<string> {
    if (!communityPool) {
        const staking = new ethers.Contract(stakingOption().contract,
            ['function communityPoolAddress() view returns (address)'], new ethers.providers.JsonRpcProvider(ConfigInstance.ether.url));
        communityPool = await staking.communityPoolAddress().catch(() => null);
    }
    return communityPool;
}

/** (2) community tax */
export async function getCommunityTax(opt: RangeOpt & {validator?: string}) {
    const head = await asOf();
    const range = await resolveRange(opt, head.asOfTime);
    const cumulative = await fromDaily('validator', opt.validator);
    const inRange = range ? await rangeGrouped('validator', opt.validator, range.from, range.to) : null;
    const list = range && opt.interval === 'day' ? await rangeGrouped('day', opt.validator, range.from, range.to) : null;
    const fmt = (t: Totals) => ({tax: t.communityTax.toString(), blockCount: t.blockCount});
    const monikers = new Map((await StakingValidator.findAll({raw: true, attributes: ['address', 'moniker']})).map(v => [v.address, v.moniker]));
    const byValidator = [...(inRange || cumulative)]
        .filter(([, t]) => t.blockCount > 0)
        .sort(([, a], [, b]) => (b.communityTax > a.communityTax ? 1 : b.communityTax < a.communityTax ? -1 : 0))
        .map(([address, t]) => ({validator: checksum(address), moniker: monikers.get(address) ?? null, ...fmt(t)}));
    return {
        communityPool: await communityPoolAddress(),
        communityTaxRate: Number(blockRewardOption().communityTaxRate),
        ...head,
        ...(opt.validator ? {validator: checksum(opt.validator)} : {}),
        cumulative: fmt(total(cumulative)),
        ...(range ? {range: {
            ...rangeHeader(range), ...fmt(total(inRange)),
            ...(list ? {list: [...list].sort(([a], [b]) => a.localeCompare(b)).map(([date, t]) => ({date, ...fmt(t)}))} : {}),
        }} : {}),
        byValidator,
    };
}

/** (3) foundation rewards, i.e. withdrawals[2] */
export async function getFoundationRewards(opt: RangeOpt) {
    const head = await asOf();
    const range = await resolveRange(opt, head.asOfTime);
    const fmt = (t: Totals) => ({amount: t.foundationReward.toString(), blockCount: t.blockCount});
    const cumulative = total(await fromDaily('validator', undefined));
    const inRange = range ? total(await rangeGrouped('validator', undefined, range.from, range.to)) : null;
    const list = range && opt.interval === 'day' ? await rangeGrouped('day', undefined, range.from, range.to) : null;
    const addresses: any[] = await StakingBlockReward.sequelize.query(
        `select distinct foundationAddress as a from ${StakingBlockReward.getTableName()}`, {type: QueryTypes.SELECT});
    return {
        foundationAddress: blockRewardOption().foundationAddress,
        ...(addresses.length > 1 ? {otherAddressesSeen: addresses.map(r => r.a).filter(a => a !== blockRewardOption().foundationAddress)} : {}),
        ...head,
        cumulative: fmt(cumulative),
        ...(range ? {range: {
            ...rangeHeader(range), ...fmt(inRange),
            ...(list ? {list: [...list].sort(([a], [b]) => a.localeCompare(b)).map(([date, t]) => ({date, ...fmt(t)}))} : {}),
        }} : {}),
    };
}

/** slashes from the blocks' slashed arrays, newest first */
export async function listSlashes(opt: {validator?: string, start?: Date, end?: Date, skip: number, limit: number}) {
    const where: any = {};
    if (opt.validator) where.validator = opt.validator;
    if (opt.start || opt.end) {
        where.createdAt = {...(opt.start ? {[Op.gte]: opt.start} : {}), ...(opt.end ? {[Op.lt]: opt.end} : {})};
    }
    const [count, rows] = await Promise.all([
        StakingBlockSlash.count({where}),
        StakingBlockSlash.findAll({where, raw: true, offset: opt.skip, limit: opt.limit, order: [['blockNumber', 'desc'], ['position', 'asc']]}),
    ]);
    return {
        total: count,
        list: rows.map(r => ({
            blockNumber: Number(r.blockNumber), timestamp: Math.floor(new Date(r.createdAt).getTime() / 1000),
            validator: checksum(r.validator), validatorIndex: r.validatorIndex, evidenceHeight: r.slashIndex,
            amount: String(r.amount),
        })),
    };
}

/** blocks proposed by one validator with their reward split, newest first */
export async function listValidatorBlocks(opt: {validator: string, start?: Date, end?: Date, skip: number, limit: number}) {
    const where: any = {validator: opt.validator};
    if (opt.start || opt.end) {
        where.createdAt = {...(opt.start ? {[Op.gte]: opt.start} : {}), ...(opt.end ? {[Op.lt]: opt.end} : {})};
    }
    const [count, rows] = await Promise.all([
        StakingBlockReward.count({where}),
        StakingBlockReward.findAll({where, raw: true, offset: opt.skip, limit: opt.limit, order: [['blockNumber', 'desc']]}),
    ]);
    return {
        total: count,
        list: rows.map(r => ({
            blockNumber: Number(r.blockNumber), timestamp: Math.floor(new Date(r.createdAt).getTime() / 1000),
            reward: String(r.reward), communityTax: String(r.communityTax), commission: String(r.commission),
            delegatorReward: (big(r.reward) - big(r.communityTax) - big(r.commission)).toString(),
            restakingReward: String(r.restakingReward), foundationReward: String(r.foundationReward),
        })),
    };
}
