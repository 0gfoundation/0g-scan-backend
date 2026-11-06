import {ethers} from "ethers";
import {fn, col, literal, Op, QueryTypes, WhereOptions} from "sequelize";
import {
    IStakingValidator,
    StakingDelegation,
    StakingEvent,
    StakingEventType,
    StakingValidator,
} from "../../model/Staking";
import {cumulativeByValidator, formatValidatorTotals} from "./StakingRewardQuery";
import {blockRewardOption} from "./StakingSync";

/**
 * Read side of the 0G validator/delegation index, for open-api.
 *
 * Conventions:
 *   - amounts are wei integer strings, percentages are strings with 2 decimals
 *   - a delegation's token value is `shares * (tokens + rewards) / delegatorShares`,
 *     the same formula as `getDelegatedTokens` on chain, from the validator row
 *     the refresher keeps current
 *   - self-delegation is the owner's delegation
 *   - delegation flows report `delegated` (sum of Delegate amounts) and
 *     `undelegated` (sum of Undelegate amounts) apart, with `net` as their
 *     difference; slashing is not included, and the initial self-stake at
 *     initialization (and at genesis) is neither event
 */

const ZERO = BigInt(0);
const ZERO_TOTALS = {
    blockCount: 0, reward: ZERO, communityTax: ZERO, commission: ZERO,
    restakingReward: ZERO, foundationReward: ZERO, slashCount: 0, slashedAmount: ZERO,
};
const HUNDRED = BigInt(100);

export const ACTIVE_BEACON_STATUS = ['active_ongoing', 'active_exiting', 'active_slashed'];

export const EVENT_TYPE_NAMES: {[name: string]: StakingEventType} = {
    delegate: StakingEventType.Delegate,
    undelegate: StakingEventType.Undelegate,
    validator_created: StakingEventType.ValidatorCreated,
    validator_initialized: StakingEventType.ValidatorInitialized,
    validator_exited: StakingEventType.ValidatorExited,
    ownership_transferred: StakingEventType.OwnershipTransferred,
    commission_rate_changed: StakingEventType.CommissionRateChanged,
    withdrawal_fee_changed: StakingEventType.WithdrawalFeeInGweiChanged,
    withdraw_commission: StakingEventType.WithdrawCommission,
    withdraw_tip_fee: StakingEventType.WithdrawTipFee,
    // no longer collected; kept so rows indexed before the change stay queryable
    exited: StakingEventType.Exited,
};
const EVENT_NAME_OF: {[t: number]: string} = Object.fromEntries(
    Object.entries(EVENT_TYPE_NAMES).map(([k, v]) => [v, k]));

const checksum = (a: string) => a ? ethers.utils.getAddress(a) : a;
const big = (v: any) => BigInt(v ?? 0);

/** a / b as a percentage string with 2 decimals, truncated; '0.00' when b is 0 */
function percent(a: bigint, b: bigint): string {
    if (b === ZERO) {
        return '0.00';
    }
    const bp = a * HUNDRED * HUNDRED / b;
    const s = bp.toString().padStart(3, '0');
    return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

function poolTokens(v: IStakingValidator): bigint {
    return big(v.tokens) + big(v.rewards);
}

function sharesToTokens(shares: bigint, v: IStakingValidator): bigint {
    const total = big(v.delegatorShares);
    return total === ZERO ? ZERO : shares * poolTokens(v) / total;
}

export function isActive(v: IStakingValidator) {
    return ACTIVE_BEACON_STATUS.includes(v.beaconStatus);
}

function formatValidator(v: IStakingValidator) {
    return {
        address: checksum(v.address),
        pubkey: v.pubkey,
        moniker: v.moniker,
        identity: v.identity,
        website: v.website,
        securityContact: v.securityContact,
        details: v.details,
        owner: checksum(v.owner),
        operator: checksum(v.operator),
        isGenesis: !!v.isGenesis,
        active: isActive(v),
        beaconStatus: v.beaconStatus,
        bondStatus: v.bondStatus,
        /** tokens + pending rewards, i.e. what the delegators' shares are worth */
        stakedAmount: poolTokens(v).toString(),
        tokens: String(v.tokens),
        rewards: String(v.rewards),
        delegatorShares: String(v.delegatorShares),
        commission: String(v.commission),
        /** raw commissionRate / 10_000, as a percentage */
        commissionRate: percent(BigInt(v.commissionRate ?? 0), BigInt(1_000_000)),
        /** raw annualPercentageYield / 100, as a percentage */
        apy: percent(big(v.apy), BigInt(10_000)),
        withdrawalFeeInGwei: String(v.withdrawalFeeInGwei),
        createdBlock: v.createdBlock,
        createdAt: v.createdAt,
        exitedBlock: v.exitedBlock,
        refreshedBlock: v.refreshedBlock,
        refreshedAt: v.refreshedAt,
    };
}

async function delegatorCounts(validators?: string[]): Promise<Map<string, number>> {
    const where: WhereOptions = {shares: {[Op.gt]: 0}};
    if (validators) {
        where['validator'] = {[Op.in]: validators};
    }
    const rows: any[] = await StakingDelegation.findAll({
        attributes: ['validator', [fn('count', col('id')), 'cnt']], where, group: ['validator'], raw: true,
    });
    return new Map(rows.map(r => [r.validator, Number(r.cnt)]));
}

/** owner's current shares per validator */
async function selfShares(validators: IStakingValidator[]): Promise<Map<string, bigint>> {
    const pairs = validators.filter(v => v.owner).map(v => ({validator: v.address, delegator: v.owner}));
    if (!pairs.length) {
        return new Map();
    }
    const rows = await StakingDelegation.findAll({
        attributes: ['validator', 'shares'], raw: true, where: {[Op.or]: pairs},
    });
    return new Map(rows.map(r => [r.validator, big(r.shares)]));
}

export async function getStakingSummary() {
    const validators = await StakingValidator.findAll({raw: true});
    const total = validators.reduce((s, v) => s + poolTokens(v), ZERO);
    const [{cnt}]: any = await StakingDelegation.findAll({
        attributes: [[fn('count', literal('distinct delegator')), 'cnt']], where: {shares: {[Op.gt]: 0}}, raw: true,
    });
    const delegations = await StakingDelegation.count({where: {shares: {[Op.gt]: 0}}});
    return {
        totalStaked: total.toString(),
        validatorCount: validators.length,
        activeValidatorCount: validators.filter(isActive).length,
        /** distinct addresses with non-zero shares on any validator */
        delegatorCount: Number(cnt),
        /** (validator, delegator) pairs with non-zero shares */
        delegationCount: delegations,
    };
}

const toUnix = (d: any) => Math.floor(new Date(d).getTime() / 1000);

/**
 * Creation and exit of each validator, from the Staking contract's
 * ValidatorInitialized and ValidatorExited (at most one of each per validator,
 * so this is one small query rather than columns to keep in sync).
 * `created` is null for genesis validators and for ones created but never
 * initialized; `exited` is null unless ValidatorExited was emitted, which a
 * slash-induced exit does not do.
 */
async function lifecycles(validators?: string[]): Promise<Map<string, {created: any, exited: any}>> {
    const where: WhereOptions = {
        eventType: {[Op.in]: [StakingEventType.ValidatorInitialized, StakingEventType.ValidatorExited]},
    };
    if (validators) {
        where['validator'] = {[Op.in]: validators};
    }
    const rows = await StakingEvent.findAll({where, raw: true, order: [['blockNumber', 'asc'], ['logIndex', 'asc']]});
    const ret = new Map<string, {created: any, exited: any}>();
    for (const r of rows) {
        const entry = ret.get(r.validator) || {created: null, exited: null};
        const common = {blockNumber: Number(r.blockNumber), txHash: r.txHash, timestamp: toUnix(r.createdAt)};
        if (r.eventType === StakingEventType.ValidatorInitialized) {
            entry.created = entry.created || {...common, operator: checksum(r.account), initialStake: String(r.amount)};
        } else {
            entry.exited = {...common};
        }
        ret.set(r.validator, entry);
    }
    return ret;
}

export type ValidatorSort = 'staked' | 'commission' | 'delegators' | 'apy';

export async function listValidators(opt: {status?: 'active' | 'inactive', term?: string, sort?: ValidatorSort, asc?: boolean}) {
    const all = await StakingValidator.findAll({raw: true});
    const grandTotal = all.reduce((s, v) => s + poolTokens(v), ZERO);
    const counts = await delegatorCounts();
    const self = await selfShares(all);
    const life = await lifecycles();
    // cumulative block rewards, only when they are being collected (all zero otherwise)
    const rewards = blockRewardOption().enabled ? await cumulativeByValidator() : null;
    const term = (opt.term || '').toLowerCase();
    let list = all.filter(v => {
        if (opt.status === 'active' && !isActive(v)) return false;
        if (opt.status === 'inactive' && isActive(v)) return false;
        return !term || v.address.includes(term) || (v.moniker || '').toLowerCase().includes(term);
    });
    const key: {[k in ValidatorSort]: (v: IStakingValidator) => bigint} = {
        staked: poolTokens,
        commission: v => BigInt(v.commissionRate ?? 0),
        delegators: v => BigInt(counts.get(v.address) ?? 0),
        apy: v => big(v.apy),
    };
    const k = key[opt.sort || 'staked'];
    list.sort((a, b) => {
        const d = k(a) - k(b);
        return (d > ZERO ? 1 : d < ZERO ? -1 : 0) * (opt.asc ? 1 : -1);
    });
    let cumulative = ZERO;
    return {
        total: list.length,
        list: list.map(v => {
            cumulative += poolTokens(v);
            const selfTokens = sharesToTokens(self.get(v.address) ?? ZERO, v);
            return {
                ...formatValidator(v),
                created: life.get(v.address)?.created ?? null,
                exited: life.get(v.address)?.exited ?? null,
                rewards: rewards ? formatValidatorTotals(rewards.get(v.address) || ZERO_TOTALS) : null,
                delegatorCount: counts.get(v.address) ?? 0,
                selfStakedAmount: selfTokens.toString(),
                /** share of the total staked on all validators */
                stakedPercent: percent(poolTokens(v), grandTotal),
                cumulativePercent: percent(cumulative, grandTotal),
            };
        }),
    };
}

export async function getValidator(address: string) {
    const v = await StakingValidator.findOne({where: {address}, raw: true});
    if (!v) {
        return null;
    }
    const counts = await delegatorCounts([address]);
    const self = sharesToTokens((await selfShares([v])).get(address) ?? ZERO, v);
    const life = (await lifecycles([address])).get(address);
    const rewards = blockRewardOption().enabled ? (await cumulativeByValidator(address)).get(address) : null;
    return {
        ...formatValidator(v),
        created: life?.created ?? null,
        exited: life?.exited ?? null,
        rewards: blockRewardOption().enabled ? formatValidatorTotals(rewards || ZERO_TOTALS) : null,
        delegatorCount: counts.get(address) ?? 0,
        selfStakedAmount: self.toString(),
        selfStakedPercent: percent(self, poolTokens(v)),
    };
}

export async function listValidatorDelegators(address: string, skip: number, limit: number, asc = false) {
    const v = await StakingValidator.findOne({where: {address}, raw: true});
    if (!v) {
        return null;
    }
    const where = {validator: address, shares: {[Op.gt]: 0}};
    const [total, rows] = await Promise.all([
        StakingDelegation.count({where}),
        StakingDelegation.findAll({
            where, raw: true, offset: skip, limit, order: [['shares', asc ? 'asc' : 'desc'], ['id', 'asc']],
        }),
    ]);
    const delegateCounts = new Map<string, number>();
    if (rows.length) {
        const cnt: any[] = await StakingEvent.findAll({
            attributes: ['account', [fn('count', col('id')), 'cnt']], raw: true, group: ['account'],
            where: {validator: address, eventType: StakingEventType.Delegate, account: {[Op.in]: rows.map(r => r.delegator)}},
        });
        cnt.forEach(r => delegateCounts.set(r.account, Number(r.cnt)));
    }
    const totalShares = big(v.delegatorShares);
    return {
        total,
        list: rows.map(r => ({
            delegator: checksum(r.delegator),
            isSelf: r.delegator === v.owner,
            shares: String(r.shares),
            amount: sharesToTokens(big(r.shares), v).toString(),
            sharePercent: percent(big(r.shares), totalShares),
            delegateCount: delegateCounts.get(r.delegator) ?? 0,
            firstBlock: r.firstBlock,
            firstAt: r.firstAt,
            lastAt: r.lastAt,
        })),
    };
}

export async function listStakingEvents(opt: {
    validator?: string, delegator?: string, types?: StakingEventType[],
    start?: Date, end?: Date, skip: number, limit: number,
}) {
    const where: WhereOptions = {};
    if (opt.validator) where['validator'] = opt.validator;
    if (opt.delegator) where['account'] = opt.delegator;
    // SlashDetected rows are the refresher's bookkeeping, not chain events: never served
    where['eventType'] = opt.types?.length
        ? {[Op.in]: opt.types.filter(t => t !== StakingEventType.SlashDetected)}
        : {[Op.ne]: StakingEventType.SlashDetected};
    if (opt.start || opt.end) {
        where['createdAt'] = {...(opt.start ? {[Op.gte]: opt.start} : {}), ...(opt.end ? {[Op.lt]: opt.end} : {})};
    }
    const [total, rows] = await Promise.all([
        StakingEvent.count({where}),
        StakingEvent.findAll({
            where, raw: true, offset: opt.skip, limit: opt.limit,
            order: [['blockNumber', 'desc'], ['logIndex', 'desc']],
        }),
    ]);
    return {
        total,
        list: rows.map(r => ({
            type: EVENT_NAME_OF[r.eventType],
            validator: checksum(r.validator),
            account: checksum(r.account),
            counterparty: checksum(r.counterparty),
            amount: r.amount == null ? null : String(r.amount),
            shares: r.shares == null ? null : String(r.shares),
            extra: r.extra,
            blockNumber: Number(r.blockNumber),
            blockHash: r.blockHash,
            txHash: r.txHash,
            logIndex: r.logIndex,
            timestamp: Math.floor(new Date(r.createdAt).getTime() / 1000),
        })),
    };
}

export type DelegatorValidatorSort = 'amount' | 'commission' | 'apy' | 'first';

export async function listDelegatorValidators(delegator: string, sort: DelegatorValidatorSort = 'amount', asc = false) {
    const rows = await StakingDelegation.findAll({where: {delegator, shares: {[Op.gt]: 0}}, raw: true});
    const validators = new Map((await StakingValidator.findAll({
        where: {address: {[Op.in]: rows.map(r => r.validator)}}, raw: true,
    })).map(v => [v.address, v]));
    const list = rows.filter(r => validators.has(r.validator)).map(r => {
        const v = validators.get(r.validator);
        return {r, v, amount: sharesToTokens(big(r.shares), v)};
    });
    const key: {[k in DelegatorValidatorSort]: (x: typeof list[0]) => bigint} = {
        amount: x => x.amount,
        commission: x => BigInt(x.v.commissionRate ?? 0),
        apy: x => big(x.v.apy),
        first: x => BigInt(x.r.firstBlock),
    };
    list.sort((a, b) => {
        const d = key[sort](a) - key[sort](b);
        return (d > ZERO ? 1 : d < ZERO ? -1 : 0) * (asc ? 1 : -1);
    });
    return {
        totalAmount: list.reduce((s, x) => s + x.amount, ZERO).toString(),
        list: list.map(({r, v, amount}) => ({
            validator: formatValidator(v),
            shares: String(r.shares),
            amount: amount.toString(),
            firstBlock: r.firstBlock,
            firstAt: r.firstAt,
            lastAt: r.lastAt,
        })),
    };
}

export async function getStakeBreakdown() {
    const validators = await StakingValidator.findAll({raw: true});
    const self = await selfShares(validators);
    let total = ZERO, selfTotal = ZERO;
    for (const v of validators) {
        total += poolTokens(v);
        selfTotal += sharesToTokens(self.get(v.address) ?? ZERO, v);
    }
    return {
        totalStaked: total.toString(),
        selfStaked: selfTotal.toString(),
        selfStakedPercent: percent(selfTotal, total),
        delegatedByOthers: (total - selfTotal).toString(),
        delegatedByOthersPercent: percent(total - selfTotal, total),
    };
}

/** UTC day or hour bucket of a DATETIME column, as a string that sorts */
function bucketExpr(interval: 'day' | 'hour') {
    return interval === 'day'
        ? `date_format(createdAt, '%Y-%m-%d')`
        : `date_format(createdAt, '%Y-%m-%d %H:00')`;
}

/**
 * Delegate and Undelegate amounts per validator per UTC day for the last
 * `days` days (today included, latest first). The two are reported apart,
 * with `net` = delegated - undelegated, never added together. Owners' own
 * delegations count like anyone else's.
 *
 * Validators are ranked within a day by volume (delegated + undelegated); the
 * top `top` are listed and the rest folded into one "others" entry, and
 * `percent` is the share of the day's volume.
 */
export async function getDelegationActivity(days: number, top: number) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const t = StakingEvent.getTableName();
    const D = StakingEventType.Delegate, U = StakingEventType.Undelegate;
    const rows: any[] = await StakingEvent.sequelize.query(
        `select ${bucketExpr('day')} as bucket, validator,
                sum(case when eventType = ${D} then amount else 0 end) as delegated,
                sum(case when eventType = ${D} then 1 else 0 end) as delegateCount,
                sum(case when eventType = ${U} then amount else 0 end) as undelegated,
                sum(case when eventType = ${U} then 1 else 0 end) as undelegateCount
         from ${t} where eventType in (${D}, ${U}) and createdAt >= ? group by bucket, validator`,
        {type: QueryTypes.SELECT, replacements: [start]});
    const monikers = new Map((await StakingValidator.findAll({attributes: ['address', 'moniker'], raw: true}))
        .map(v => [v.address, v.moniker]));

    type Flow = {delegated: bigint, undelegated: bigint, delegateCount: number, undelegateCount: number};
    const empty = (): Flow => ({delegated: ZERO, undelegated: ZERO, delegateCount: 0, undelegateCount: 0});
    const add = (a: Flow, b: Flow): Flow => ({
        delegated: a.delegated + b.delegated, undelegated: a.undelegated + b.undelegated,
        delegateCount: a.delegateCount + b.delegateCount, undelegateCount: a.undelegateCount + b.undelegateCount,
    });
    const volume = (f: Flow) => f.delegated + f.undelegated;
    const format = (f: Flow, dayVolume: bigint) => ({
        delegated: f.delegated.toString(), delegateCount: f.delegateCount,
        undelegated: f.undelegated.toString(), undelegateCount: f.undelegateCount,
        net: (f.delegated - f.undelegated).toString(),
        percent: percent(volume(f), dayVolume),
    });

    const result = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(start.getTime() + i * 86400_000);
        const bucket = d.toISOString().slice(0, 10);
        const dayRows = rows.filter(r => r.bucket === bucket)
            .map(r => ({
                validator: r.validator as string,
                flow: {
                    delegated: big(r.delegated), undelegated: big(r.undelegated),
                    delegateCount: Number(r.delegateCount), undelegateCount: Number(r.undelegateCount),
                } as Flow,
            }))
            .sort((a, b) => {
                const x = volume(b.flow) - volume(a.flow);
                return x > ZERO ? 1 : x < ZERO ? -1 : 0;
            });
        const day = dayRows.reduce((s, r) => add(s, r.flow), empty());
        const dayVolume = volume(day);
        const shown: any[] = dayRows.slice(0, top).map(r => ({
            validator: checksum(r.validator), moniker: monikers.get(r.validator) ?? '',
            ...format(r.flow, dayVolume),
        }));
        const rest = dayRows.slice(top);
        if (rest.length) {
            shown.push({
                validator: null, moniker: 'others',
                ...format(rest.reduce((s, r) => add(s, r.flow), empty()), dayVolume),
            });
        }
        const {percent: _, ...dayTotals} = format(day, dayVolume);
        result.push({date: bucket, timestamp: d.getTime() / 1000, ...dayTotals, validators: shown});
    }
    return {list: result};
}

const FLOW_TYPES = `${StakingEventType.Delegate}, ${StakingEventType.Undelegate}`;
/** select list summing Delegate and Undelegate apart, for `formatFlow` */
const FLOW_COLS = `sum(case when eventType = ${StakingEventType.Delegate} then amount else 0 end) as delegated,
    sum(case when eventType = ${StakingEventType.Delegate} then 1 else 0 end) as delegateCount,
    sum(case when eventType = ${StakingEventType.Undelegate} then amount else 0 end) as undelegated,
    sum(case when eventType = ${StakingEventType.Undelegate} then 1 else 0 end) as undelegateCount`;

function formatFlow(r: any) {
    const delegated = big(r?.delegated), undelegated = big(r?.undelegated);
    return {
        delegated: delegated.toString(), delegateCount: Number(r?.delegateCount ?? 0),
        undelegated: undelegated.toString(), undelegateCount: Number(r?.undelegateCount ?? 0),
        net: (delegated - undelegated).toString(),
    };
}

/**
 * Delegate and Undelegate amounts into one validator over [start, end),
 * optionally bucketed. Reported apart with `net` = delegated - undelegated;
 * the initial self-stake at initialization is neither, so it is not included.
 */
export async function sumValidatorDelegations(validator: string, start: Date, end: Date, interval?: 'day' | 'hour') {
    const t = StakingEvent.getTableName();
    const cols = FLOW_COLS;
    const cond = `validator = ? and eventType in (${FLOW_TYPES}) and createdAt >= ? and createdAt < ?`;
    const replacements = [validator, start, end];
    const flow = formatFlow;
    const [sum]: any[] = await StakingEvent.sequelize.query(
        `select ${cols} from ${t} where ${cond}`, {type: QueryTypes.SELECT, replacements});
    const ret: any = {
        validator: checksum(validator),
        start: start.getTime() / 1000, end: end.getTime() / 1000,
        ...flow(sum),
    };
    if (interval) {
        const rows: any[] = await StakingEvent.sequelize.query(
            `select ${bucketExpr(interval)} as bucket, ${cols} from ${t} where ${cond} group by bucket order by bucket`,
            {type: QueryTypes.SELECT, replacements});
        ret.interval = interval;
        ret.list = rows.map(r => ({bucket: r.bucket, ...flow(r)}));
    }
    return ret;
}

/**
 * Delegate and Undelegate amounts by one delegator across all validators,
 * optionally within [start, end), with a per-validator breakdown ordered by
 * volume (delegated + undelegated). Attributed to the delegator, not the payer.
 */
export async function sumDelegatorDelegations(delegator: string, start?: Date, end?: Date) {
    const t = StakingEvent.getTableName();
    const replacements: any[] = [delegator];
    let cond = `account = ? and eventType in (${FLOW_TYPES})`;
    if (start) {
        cond += ` and createdAt >= ?`;
        replacements.push(start);
    }
    if (end) {
        cond += ` and createdAt < ?`;
        replacements.push(end);
    }
    const rows: any[] = await StakingEvent.sequelize.query(
        `select validator, ${FLOW_COLS} from ${t} where ${cond} group by validator`,
        {type: QueryTypes.SELECT, replacements});
    const volume = (r: any) => big(r.delegated) + big(r.undelegated);
    rows.sort((a, b) => {
        const d = volume(b) - volume(a);
        return d > ZERO ? 1 : d < ZERO ? -1 : 0;
    });
    const total = rows.reduce((s, r) => ({
        delegated: s.delegated + big(r.delegated), delegateCount: s.delegateCount + Number(r.delegateCount),
        undelegated: s.undelegated + big(r.undelegated), undelegateCount: s.undelegateCount + Number(r.undelegateCount),
    }), {delegated: ZERO, delegateCount: 0, undelegated: ZERO, undelegateCount: 0});
    return {
        delegator: checksum(delegator),
        start: start ? start.getTime() / 1000 : null,
        end: end ? end.getTime() / 1000 : null,
        ...formatFlow(total),
        list: rows.map(r => ({validator: checksum(r.validator), ...formatFlow(r)})),
    };
}

export type ParamChangeType = 'commission_rate' | 'withdrawal_fee';
const PARAM_CHANGE_TYPE: {[k in ParamChangeType]: StakingEventType} = {
    commission_rate: StakingEventType.CommissionRateChanged,
    withdrawal_fee: StakingEventType.WithdrawalFeeInGweiChanged,
};

/**
 * CommissionRateChanged / WithdrawalFeeInGweiChanged of one validator, newest
 * first. Commission rates are raw (1e6 = 100%) with a percentage alongside;
 * withdrawal fees are gwei.
 */
export async function listParamChanges(validator: string, types: ParamChangeType[], skip: number, limit: number) {
    const where = {
        validator,
        eventType: {[Op.in]: (types.length ? types : Object.keys(PARAM_CHANGE_TYPE) as ParamChangeType[]).map(t => PARAM_CHANGE_TYPE[t])},
    };
    const [total, rows] = await Promise.all([
        StakingEvent.count({where}),
        StakingEvent.findAll({where, raw: true, offset: skip, limit, order: [['blockNumber', 'desc'], ['logIndex', 'desc']]}),
    ]);
    const RATE_BASE = BigInt(1_000_000);
    return {
        total,
        list: rows.map(r => {
            const isRate = r.eventType === StakingEventType.CommissionRateChanged;
            const {old: oldValue, new: newValue} = (typeof r.extra === 'string' ? JSON.parse(r.extra) : r.extra) as any;
            return {
                type: isRate ? 'commission_rate' : 'withdrawal_fee',
                oldValue, newValue,
                oldPercent: isRate ? percent(BigInt(oldValue), RATE_BASE) : null,
                newPercent: isRate ? percent(BigInt(newValue), RATE_BASE) : null,
                blockNumber: Number(r.blockNumber), txHash: r.txHash, timestamp: toUnix(r.createdAt),
            };
        }),
    };
}

/**
 * Commission and tip fee per validator: what is still in the contract
 * (`commission()` / `tipFee()` as of the last refresh) plus what has been
 * withdrawn (WithdrawCommission / WithdrawTipFee). A commission withdrawal
 * only moves it into the withdrawal queue, so "withdrawn" means taken out of
 * the balance, not necessarily paid out yet.
 *
 * An exit moves the owner's stake into commission() too (deployed contract
 * behaviour, not in the source we have), so for exited validators
 * current/withdrawn include it; commission.total leaves it out and
 * commission.exitSettlement reports it.
 */
export async function getFees(validator?: string) {
    const t = StakingEvent.getTableName();
    const C = StakingEventType.WithdrawCommission, P = StakingEventType.WithdrawTipFee;
    const withdrawn: any[] = await StakingEvent.sequelize.query(
        `select validator,
                sum(case when eventType = ${C} then amount else 0 end) as commissionWithdrawn,
                sum(case when eventType = ${C} then 1 else 0 end) as commissionCount,
                sum(case when eventType = ${P} then amount else 0 end) as tipFeeWithdrawn,
                sum(case when eventType = ${P} then 1 else 0 end) as tipFeeCount
         from ${t} where eventType in (${C}, ${P})${validator ? ' and validator = ?' : ''} group by validator`,
        {type: QueryTypes.SELECT, replacements: validator ? [validator] : []});
    const byValidator = new Map(withdrawn.map(r => [r.validator, r]));
    const validators = await StakingValidator.findAll({
        raw: true, where: validator ? {address: validator} : {},
        attributes: ['address', 'moniker', 'commission', 'tipFee', 'refreshedBlock'],
    });
    // what each exit moved into commission() (recorded by the sync on ValidatorExited)
    const exits = await StakingEvent.findAll({
        raw: true, attributes: ['validator', 'extra'],
        where: {eventType: StakingEventType.ValidatorExited, ...(validator ? {validator} : {})},
    });
    const settlement = new Map<string, bigint | null>();
    for (const e of exits) {
        const x: any = typeof e.extra === 'string' ? JSON.parse(e.extra) : (e.extra || {});
        const prev = settlement.has(e.validator) ? settlement.get(e.validator) : ZERO;
        settlement.set(e.validator, prev == null || x.exitSettlement == null ? null : prev + BigInt(x.exitSettlement));
    }
    const part = (current: any, done: any, count: any, exitSettlement: bigint | null = ZERO) => {
        const c = big(current), w = big(done);
        return {
            current: c.toString(), withdrawn: w.toString(),
            total: (c + w - (exitSettlement ?? ZERO)).toString(), withdrawCount: Number(count ?? 0),
        };
    };
    const list = validators.map(v => {
        const w = byValidator.get(v.address);
        const exitSettlement = settlement.has(v.address) ? settlement.get(v.address) : ZERO;
        const commission = {
            ...part(v.commission, w?.commissionWithdrawn, w?.commissionCount, exitSettlement),
            // the owner's stake an exit moved into commission(): part of current/withdrawn, not of total;
            // null when it could not be read, and then total still includes it
            exitSettlement: exitSettlement == null ? null : exitSettlement.toString(),
        };
        const tipFee = part(v.tipFee, w?.tipFeeWithdrawn, w?.tipFeeCount);
        return {
            validator: checksum(v.address), moniker: v.moniker,
            commission, tipFee,
            total: (BigInt(commission.total) + BigInt(tipFee.total)).toString(),
            refreshedBlock: v.refreshedBlock == null ? null : Number(v.refreshedBlock),
        };
    });
    list.sort((a, b) => {
        const d = BigInt(b.total) - BigInt(a.total);
        return d > ZERO ? 1 : d < ZERO ? -1 : 0;
    });
    return {list};
}

export type FeeWithdrawalType = 'commission' | 'tip_fee';
const FEE_WITHDRAWAL_TYPE: {[k in FeeWithdrawalType]: StakingEventType} = {
    commission: StakingEventType.WithdrawCommission,
    tip_fee: StakingEventType.WithdrawTipFee,
};

/** WithdrawCommission / WithdrawTipFee of one validator, newest first. */
export async function listFeeWithdrawals(opt: {
    validator: string, types: FeeWithdrawalType[], start?: Date, end?: Date, skip: number, limit: number,
}) {
    const where: WhereOptions = {
        validator: opt.validator,
        eventType: {[Op.in]: (opt.types.length ? opt.types : Object.keys(FEE_WITHDRAWAL_TYPE) as FeeWithdrawalType[]).map(t => FEE_WITHDRAWAL_TYPE[t])},
    };
    if (opt.start || opt.end) {
        where['createdAt'] = {...(opt.start ? {[Op.gte]: opt.start} : {}), ...(opt.end ? {[Op.lt]: opt.end} : {})};
    }
    const [total, rows] = await Promise.all([
        StakingEvent.count({where}),
        StakingEvent.findAll({where, raw: true, offset: opt.skip, limit: opt.limit, order: [['blockNumber', 'desc'], ['logIndex', 'desc']]}),
    ]);
    return {
        total,
        list: rows.map(r => ({
            type: r.eventType === StakingEventType.WithdrawCommission ? 'commission' : 'tip_fee',
            owner: checksum(r.account),
            withdrawalAddress: checksum(r.counterparty),
            amount: String(r.amount),
            blockNumber: Number(r.blockNumber), txHash: r.txHash, timestamp: toUnix(r.createdAt),
        })),
    };
}
