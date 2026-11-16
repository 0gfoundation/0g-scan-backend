import {ethers} from "ethers";
import {Op, QueryTypes} from "sequelize";
import {ConfigInstance} from "../../config/StatConfig";
import {KV} from "../../model/KV";
import {
    IStakingCommissionCheck,
    StakingBlockReward,
    StakingCommissionCheck,
    StakingEvent,
    StakingEventType,
    StakingValidator,
} from "../../model/Staking";
import {safeAddErrorLog} from "../../monitor/ErrorMonitor";
import {blockRewardOption, getStakingCursor, stakingOption} from "./StakingSync";

/**
 * Checks run alongside the block sync (PLAN.md "对账与告警"):
 *
 * - commission: at checkpoints, commission() of every validator is read at the
 *   block-reward cursor and compared with the previous checkpoint:
 *     actual   = commission(now) - commission(prev) + Σ WithdrawCommission
 *                - Σ exit settlement (old-implementation exits move the owner's
 *                stake into commission)
 *     expected = Σ per-block commission the block sync computed
 *   over (prev, now]. A mismatch means the qualification timeline (or the rate)
 *   is wrong somewhere in that window; `check-commission` narrows it down.
 *   Checkpoints are read at the cursor, which is near the head once caught up,
 *   so this works on an RPC without history. When the state is not available
 *   (backfilling without an archive node) no checkpoint is written, and the
 *   next one that can be read covers the whole gap.
 * - community tax rate: setCommunityTaxRate emits nothing, so the rate is read
 *   at each checkpoint and compared with the configured one.
 * - freshness: once the sync has caught up, the collected head falling behind
 *   wall-clock time by more than freshnessAlertSec is reported.
 */

const KEY_TAX_RATE_SEEN = 'STAKING_COMMUNITY_TAX_RATE_SEEN';
const SEL_COMMISSION = ethers.utils.id('commission()').slice(0, 10);
const SEL_TAX_RATE = ethers.utils.id('communityTaxRate()').slice(0, 10);
const CALLS_PER_BATCH = 40;
const RPC_RETRIES = 6;
const STATE_UNAVAILABLE = /missing trie node|is not available|header not found|state.*pruned/i;
const ALERT_EVERY_MS = 10 * 60 * 1000;

const ctx = {
    everCaughtUp: false,
    lastFreshnessAlert: 0,
    /** a checkpoint read found no state while backfilling; wait until caught up */
    stateMissing: false,
    lastDeferLog: 0,
};

class StateUnavailable extends Error {}

/** eth_call results at `block`, in order; '0x' for an address with no code there */
async function callsAt(calls: {to: string, data: string}[], block: number): Promise<string[]> {
    const out: string[] = [];
    const tag = '0x' + block.toString(16);
    for (let i = 0; i < calls.length; i += CALLS_PER_BATCH) {
        const body = calls.slice(i, i + CALLS_PER_BATCH).map((c, id) => ({jsonrpc: '2.0', id, method: 'eth_call', params: [c, tag]}));
        for (let attempt = 0; ; attempt++) {
            let json: any[];
            try {
                const resp = await fetch(ConfigInstance.ether.url, {
                    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
                });
                json = await resp.json();
                if (!Array.isArray(json)) {
                    throw new Error(`rpc: ${JSON.stringify(json).slice(0, 200)}`);
                }
            } catch (e) {
                if (attempt >= RPC_RETRIES) throw e;
                await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
                continue;
            }
            const failed = json.find(r => r.error);
            if (failed) {
                // only some nodes behind the public RPC keep history: retry, then give up
                const msg = JSON.stringify(failed.error);
                if (attempt >= RPC_RETRIES) {
                    throw STATE_UNAVAILABLE.test(msg) ? new StateUnavailable(msg) : new Error(`rpc error: ${msg}`);
                }
                await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
                continue;
            }
            const byId = new Map(json.map(r => [r.id, r.result]));
            body.forEach(b => out.push(byId.get(b.id)));
            break;
        }
    }
    return out;
}

function sumBy(rows: any[]): Map<string, bigint> {
    return new Map(rows.map(r => [r.validator, BigInt(r.s)]));
}

export interface CommissionCheckResult {
    block: number
    prevBlocks: number[]
    taxRate: number
    counts: {[status: string]: number}
    mismatches: {validator: string, prevBlock: number, expected: string, actual: string}[]
}

/**
 * One checkpoint at the block-reward cursor. Returns null when it is not due
 * (less than checkIntervalSec of chain time since the last one, unless
 * `force`) or nothing has been collected, and throws StateUnavailable when the
 * RPC has no state for the cursor block.
 */
export async function commissionCheckOnce(cursor: number, force = false): Promise<CommissionCheckResult | null> {
    const opt = blockRewardOption();
    const head = await StakingBlockReward.findByPk(cursor, {raw: true, attributes: ['blockNumber', 'createdAt']});
    if (!head) {
        return null;
    }
    const last = await StakingCommissionCheck.findOne({raw: true, order: [['blockNumber', 'desc']], attributes: ['blockNumber', 'createdAt']});
    if (last && Number(last.blockNumber) >= cursor) {
        return null;
    }
    if (last && !force && new Date(head.createdAt).getTime() - new Date(last.createdAt).getTime() < opt.checkIntervalSec * 1000) {
        return null;
    }

    const validators = (await StakingValidator.findAll({raw: true, attributes: ['address']})).map(v => v.address);
    const staking = stakingOption().contract;
    const results = await callsAt([
        ...validators.map(to => ({to, data: SEL_COMMISSION})),
        {to: staking, data: SEL_TAX_RATE},
    ], cursor);

    // community tax rate
    const taxRate = Number(BigInt(results[validators.length]));
    const seen = await KV.getString(KEY_TAX_RATE_SEEN, '');
    if (BigInt(taxRate) !== opt.communityTaxRate) {
        const msg = `communityTaxRate() is ${taxRate} at ${cursor}, but ${opt.communityTaxRate} is configured; community tax is computed with the configured rate`;
        console.log(`staking check: ${msg}`);
        safeAddErrorLog('staking', 'tax-rate', new Error(msg));
    }
    if (seen !== String(taxRate)) {
        await KV.upsert({key: KEY_TAX_RATE_SEEN, value: String(taxRate)});
    }

    // commission: each validator against its own previous checkpoint
    const current = new Map<string, bigint>();
    validators.forEach((v, i) => {
        // no code at the cursor block: created after it, checked from the next checkpoint
        if (results[i] && results[i] !== '0x') current.set(v, BigInt(results[i]));
    });
    const prevRows: any[] = await StakingCommissionCheck.sequelize.query(
        `select c.validator, c.blockNumber, cast(c.commission as char) as commission
         from ${StakingCommissionCheck.getTableName()} c
         join (select validator, max(blockNumber) as b from ${StakingCommissionCheck.getTableName()} group by validator) m
           on m.validator = c.validator and m.b = c.blockNumber`,
        {type: QueryTypes.SELECT});
    const prev = new Map(prevRows.map(r => [r.validator, {block: Number(r.blockNumber), commission: BigInt(r.commission)}]));

    const windows = new Map<number, {expected: Map<string, bigint>, withdrawn: Map<string, bigint>, settled: Map<string, bigint | null>}>();
    for (const p of new Set([...prev.values()].map(x => x.block))) {
        const range = [p, cursor];
        const expected = sumBy(await StakingBlockReward.sequelize.query(
            `select validator, cast(sum(commission) as char) as s from ${StakingBlockReward.getTableName()}
             where blockNumber > ? and blockNumber <= ? group by validator`,
            {type: QueryTypes.SELECT, replacements: range}));
        const withdrawn = sumBy(await StakingEvent.sequelize.query(
            `select validator, cast(sum(amount) as char) as s from ${StakingEvent.getTableName()}
             where eventType = ? and blockNumber > ? and blockNumber <= ? group by validator`,
            {type: QueryTypes.SELECT, replacements: [StakingEventType.WithdrawCommission, ...range]}));
        const settled = new Map<string, bigint | null>();
        const exits = await StakingEvent.findAll({
            raw: true, attributes: ['validator', 'extra'],
            where: {eventType: StakingEventType.ValidatorExited, blockNumber: {[Op.gt]: p, [Op.lte]: cursor}},
        });
        for (const e of exits) {
            const x = (typeof e.extra === 'string' ? JSON.parse(e.extra) : e.extra) as any || {};
            if (x.implementation !== 'stake-to-commission') continue;
            const before = settled.has(e.validator) ? settled.get(e.validator) : BigInt(0);
            settled.set(e.validator, before == null || x.exitSettlement == null ? null : before + BigInt(x.exitSettlement));
        }
        windows.set(p, {expected, withdrawn, settled});
    }

    const rows: IStakingCommissionCheck[] = [];
    const mismatches: CommissionCheckResult['mismatches'] = [];
    for (const [validator, commission] of current) {
        const row: IStakingCommissionCheck = {
            blockNumber: cursor, createdAt: head.createdAt, validator, commission: commission.toString(),
            prevBlock: null, expected: null, actual: null, status: 'baseline',
        };
        const p = prev.get(validator);
        if (p) {
            const w = windows.get(p.block);
            const settlement = w.settled.has(validator) ? w.settled.get(validator) : BigInt(0);
            const expected = w.expected.get(validator) ?? BigInt(0);
            row.prevBlock = p.block;
            row.expected = expected.toString();
            if (settlement == null) {
                row.status = 'unknown';
            } else {
                const actual = commission - p.commission + (w.withdrawn.get(validator) ?? BigInt(0)) - settlement;
                row.actual = actual.toString();
                row.status = actual === expected ? 'ok' : 'mismatch';
                if (row.status === 'mismatch') {
                    mismatches.push({validator, prevBlock: p.block, expected: row.expected, actual: row.actual});
                }
            }
        }
        rows.push(row);
    }
    await StakingCommissionCheck.bulkCreate(rows);

    if (mismatches.length) {
        const first = mismatches[0];
        const msg = `commission mismatch for ${mismatches.length} validator(s) up to ${cursor}, first ${first.validator} over (${first.prevBlock}, ${cursor}]: `
            + `chain ${first.actual}, collected ${first.expected}; narrow it down with check-commission ${first.validator} ${first.prevBlock + 1} ${cursor}`;
        console.log(`staking check: ${msg}`);
        safeAddErrorLog('staking', 'commission-check', new Error(msg));
    }
    const counts: {[s: string]: number} = {};
    rows.forEach(r => counts[r.status] = (counts[r.status] || 0) + 1);
    return {block: cursor, prevBlocks: [...windows.keys()], taxRate, counts, mismatches};
}

/** Called by the block sync loop after every round. Never throws. */
export async function runChecks(cursor: number, caughtUp: boolean) {
    ctx.everCaughtUp = ctx.everCaughtUp || caughtUp;
    await checkFreshness(cursor).catch(e => console.log(`staking check: freshness failed:`, e?.message || e));
    // without an archive node a backfill has no state to read: don't retry every round
    if (ctx.stateMissing && !caughtUp) {
        return;
    }
    try {
        await commissionCheckOnce(cursor);
        ctx.stateMissing = false;
    } catch (e) {
        if (e instanceof StateUnavailable) {
            ctx.stateMissing = true;
            if (Date.now() - ctx.lastDeferLog > ALERT_EVERY_MS) {
                ctx.lastDeferLog = Date.now();
                console.log(`staking check: no state at ${cursor}, commission checkpoint deferred; the next one covers the gap`);
            }
        } else {
            console.log(`staking check: commission check failed:`, e?.message || e);
            safeAddErrorLog('staking', 'commission-check', e);
        }
    }
}

async function checkFreshness(cursor: number) {
    if (!ctx.everCaughtUp) {
        return;
    }
    const row = await StakingBlockReward.findByPk(cursor, {raw: true, attributes: ['createdAt']});
    if (!row) {
        return;
    }
    const lagSec = Math.round((Date.now() - new Date(row.createdAt).getTime()) / 1000);
    if (lagSec <= blockRewardOption().freshnessAlertSec || Date.now() - ctx.lastFreshnessAlert < ALERT_EVERY_MS) {
        return;
    }
    ctx.lastFreshnessAlert = Date.now();
    const msg = `block rewards are ${lagSec}s behind (block ${cursor}); the event sync, which they wait for, is at ${await getStakingCursor()}`;
    console.log(`staking check: ${msg}`);
    safeAddErrorLog('staking', 'freshness', new Error(msg));
}
