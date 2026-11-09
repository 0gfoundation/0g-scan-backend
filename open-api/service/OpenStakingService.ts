import {ethers} from "ethers";
import {paginateCore} from "../../stat/router/ParamChecker";
import {Errors} from "../../stat/service/common/LogicError";
import {
    DelegatorValidatorSort,
    EVENT_TYPE_NAMES,
    FeeWithdrawalType,
    getFees,
    listFeeWithdrawals,
    listParamChanges,
    ParamChangeType,
    getDelegationActivity,
    getStakeBreakdown,
    getStakingSummary,
    getValidator,
    listDelegatorValidators,
    listStakingEvents,
    listValidatorDelegators,
    listValidators,
    sumDelegatorDelegations,
    sumValidatorDelegations,
    ValidatorSort,
} from "../../stat/service/staking/StakingQuery";
import {
    getCommunityTax,
    getFoundationRewards,
    getValidatorRewards,
    listSlashes,
    listValidatorBlocks,
    RewardSort,
} from "../../stat/service/staking/StakingRewardQuery";
import {setBody} from "../router/middleware";

/**
 * 0G validator/delegation endpoints under /open/staking. Amounts are wei
 * integer strings; times are unix seconds. See StakingQuery for the
 * definitions behind each number.
 */

const MAX_SUM_RANGE_DAYS = 366;
const MAX_ACTIVITY_DAYS = 30;

function paramError(message: string): never {
    throw new Errors.ParameterError(message);
}

function address(query, key: string, required = true): string | undefined {
    const v = (query[key] || '').toString().trim();
    if (!v) {
        return required ? paramError(`parameter <${key}> is required`) : undefined;
    }
    if (!ethers.utils.isAddress(v)) {
        paramError(`parameter <${key}> is not a valid address`);
    }
    return v.toLowerCase();
}

function oneOf<T extends string>(query, key: string, allowed: readonly T[], dft?: T): T | undefined {
    const v = (query[key] || '').toString().trim();
    if (!v) {
        return dft;
    }
    if (!allowed.includes(v as T)) {
        paramError(`parameter <${key}> must be one of ${allowed.join(', ')}`);
    }
    return v as T;
}

function unixTime(query, key: string): Date | undefined {
    const v = (query[key] || '').toString().trim();
    if (!v) {
        return undefined;
    }
    if (!/^\d{1,11}$/.test(v)) {
        paramError(`parameter <${key}> must be a unix timestamp in seconds`);
    }
    return new Date(Number(v) * 1000);
}

function isAsc(query) {
    return oneOf(query, 'order', ['asc', 'desc'] as const, 'desc') === 'asc';
}

export async function getSummary(ctx) {
    setBody(ctx, await getStakingSummary());
}

export async function getValidatorList(ctx) {
    const q = ctx.query;
    setBody(ctx, await listValidators({
        status: oneOf(q, 'status', ['active', 'inactive'] as const),
        term: (q.term || '').toString().trim(),
        sort: oneOf<ValidatorSort>(q, 'sort', ['staked', 'commission', 'delegators', 'apy'], 'staked'),
        asc: isAsc(q),
    }));
}

export async function getValidatorDetail(ctx) {
    const v = await getValidator(address(ctx.query, 'address'));
    if (!v) {
        paramError(`validator not found`);
    }
    setBody(ctx, v);
}

export async function getValidatorDelegators(ctx) {
    const q = ctx.query;
    const {skip, limit} = paginateCore(q);
    const ret = await listValidatorDelegators(address(q, 'address'), skip, limit, isAsc(q));
    if (!ret) {
        paramError(`validator not found`);
    }
    setBody(ctx, ret);
}

export async function getEvents(ctx) {
    const q = ctx.query;
    const {skip, limit} = paginateCore(q);
    const types = (q.type || '').toString().split(',').map(s => s.trim()).filter(Boolean).map(t => {
        if (!(t in EVENT_TYPE_NAMES)) {
            paramError(`parameter <type> must be a comma separated list of ${Object.keys(EVENT_TYPE_NAMES).join(', ')}`);
        }
        return EVENT_TYPE_NAMES[t];
    });
    setBody(ctx, await listStakingEvents({
        validator: address(q, 'validator', false),
        delegator: address(q, 'delegator', false),
        types, start: unixTime(q, 'start'), end: unixTime(q, 'end'), skip, limit,
    }));
}

export async function getDelegatorValidators(ctx) {
    const q = ctx.query;
    setBody(ctx, await listDelegatorValidators(
        address(q, 'address'),
        oneOf<DelegatorValidatorSort>(q, 'sort', ['amount', 'commission', 'apy', 'first'], 'amount'),
        isAsc(q),
    ));
}

export async function getBreakdown(ctx) {
    setBody(ctx, await getStakeBreakdown());
}

export async function getActivity(ctx) {
    const days = Number(ctx.query.days || 5);
    if (!Number.isInteger(days) || days < 1 || days > MAX_ACTIVITY_DAYS) {
        paramError(`parameter <days> must be an integer between 1 and ${MAX_ACTIVITY_DAYS}`);
    }
    setBody(ctx, await getDelegationActivity(days, 10));
}

export async function getValidatorDelegationSum(ctx) {
    const q = ctx.query;
    const validator = address(q, 'address');
    const start = unixTime(q, 'start') ?? paramError(`parameter <start> is required`);
    const end = unixTime(q, 'end') ?? new Date();
    if (start.getTime() >= end.getTime()) {
        paramError(`<start> must be before <end>`);
    }
    if (end.getTime() - start.getTime() > MAX_SUM_RANGE_DAYS * 86400_000) {
        paramError(`range must not exceed ${MAX_SUM_RANGE_DAYS} days`);
    }
    const interval = oneOf(q, 'interval', ['day', 'hour'] as const);
    if (interval === 'hour' && end.getTime() - start.getTime() > 31 * 86400_000) {
        paramError(`hourly buckets are limited to 31 days`);
    }
    setBody(ctx, await sumValidatorDelegations(validator, start, end, interval));
}

export async function getDelegatorDelegationSum(ctx) {
    const q = ctx.query;
    const start = unixTime(q, 'start');
    const end = unixTime(q, 'end');
    if (start && end && start.getTime() >= end.getTime()) {
        paramError(`<start> must be before <end>`);
    }
    setBody(ctx, await sumDelegatorDelegations(address(q, 'address'), start, end));
}

/** comma separated values of `key`, each one of `allowed`; empty when absent */
function listOf<T extends string>(query, key: string, allowed: readonly T[]): T[] {
    const values = (query[key] || '').toString().split(',').map(v => v.trim()).filter(Boolean);
    for (const v of values) {
        if (!allowed.includes(v as T)) {
            paramError(`parameter <${key}> must be a comma separated list of ${allowed.join(', ')}`);
        }
    }
    return values as T[];
}

export async function getValidatorParamChanges(ctx) {
    const q = ctx.query;
    const {skip, limit} = paginateCore(q);
    setBody(ctx, await listParamChanges(
        address(q, 'address'),
        listOf<ParamChangeType>(q, 'type', ['commission_rate', 'withdrawal_fee']),
        skip, limit,
    ));
}

export async function getValidatorFees(ctx) {
    setBody(ctx, await getFees(address(ctx.query, 'address', false)));
}

export async function getValidatorFeeWithdrawals(ctx) {
    const q = ctx.query;
    const {skip, limit} = paginateCore(q);
    const start = unixTime(q, 'start');
    const end = unixTime(q, 'end');
    if (start && end && start.getTime() >= end.getTime()) {
        paramError(`<start> must be before <end>`);
    }
    setBody(ctx, await listFeeWithdrawals({
        validator: address(q, 'address'),
        types: listOf<FeeWithdrawalType>(q, 'type', ['commission', 'tip_fee']),
        start, end, skip, limit,
    }));
}

/** start (optional) / end (default now) / interval for the reward statistics */
function rewardRange(q) {
    const start = unixTime(q, 'start');
    const end = unixTime(q, 'end');
    const interval = oneOf(q, 'interval', ['day'] as const);
    if (!start && (end || interval)) {
        paramError(`<end> and <interval> need <start>`);
    }
    if (start) {
        const to = (end ?? new Date()).getTime();
        if (start.getTime() >= to) {
            paramError(`<start> must be before <end>`);
        }
        if (to - start.getTime() > MAX_SUM_RANGE_DAYS * 86400_000) {
            paramError(`range must not exceed ${MAX_SUM_RANGE_DAYS} days`);
        }
    }
    return {start, end, interval};
}

export async function getRewards(ctx) {
    const q = ctx.query;
    setBody(ctx, await getValidatorRewards({
        validator: address(q, 'address', false),
        sort: oneOf<RewardSort>(q, 'sort', ['reward', 'commission', 'blockCount', 'slashedAmount'], 'reward'),
        ...rewardRange(q),
    }));
}

export async function getTax(ctx) {
    const q = ctx.query;
    setBody(ctx, await getCommunityTax({validator: address(q, 'validator', false), ...rewardRange(q)}));
}

export async function getFoundation(ctx) {
    setBody(ctx, await getFoundationRewards(rewardRange(ctx.query)));
}

export async function getSlashes(ctx) {
    const q = ctx.query;
    const {skip, limit} = paginateCore(q);
    setBody(ctx, await listSlashes({
        validator: address(q, 'validator', false), start: unixTime(q, 'start'), end: unixTime(q, 'end'), skip, limit,
    }));
}

export async function getValidatorBlocks(ctx) {
    const q = ctx.query;
    const {skip, limit} = paginateCore(q);
    setBody(ctx, await listValidatorBlocks({
        validator: address(q, 'address'), start: unixTime(q, 'start'), end: unixTime(q, 'end'), skip, limit,
    }));
}
