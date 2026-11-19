import {QueryTypes} from "sequelize";
import {KV} from "../../model/KV";
import {
    StakingBlockReward,
    StakingBlockSlash,
    StakingCommissionCheck,
    StakingEvent,
    StakingEventType,
    StakingRestakingDaily,
    StakingRewardDaily,
    StakingSelfDelegation,
} from "../../model/Staking";
import {validatorRpcUrl} from "../ZGSupply";
import {communityPoolHistory, getBlockRewardCursor, otherFoundationAddresses, reconcileBlockRewards} from "./StakingBlockSync";
import {commissionCheckOnce} from "./StakingCheck";
import {reconcileAllShares} from "./StakingRefresher";
import {staticProvider, withRateRetry} from "./StakingRpc";
import {blockRewardOption, getStakingCursor, stakingOption, stakingRpcUrl, trackedBeacon} from "./StakingSync";

/**
 * Whether the indexed data can be signed off as complete and exact: every
 * check that can be made against the chain or the consensus layer, in one
 * pass. `pass` only when none fails; a skipped check says why it could not
 * run. Meant for mainnet after the backfill (PLAN.md, strict mode); run with
 * an RPC that serves historical state.
 */

type Status = 'pass' | 'fail' | 'skip';
interface Check {
    name: string
    status: Status
    detail: string
}

const HEAD_LAG = 100;

async function one(sql: string, replacements: any[] = []): Promise<any> {
    const [row]: any[] = await StakingBlockReward.sequelize.query(sql, {type: QueryTypes.SELECT, replacements});
    return row;
}

export async function accuracyReport(): Promise<{pass: boolean, checks: Check[]}> {
    const checks: Check[] = [];
    const add = (name: string, status: Status, detail: string) => checks.push({name, status, detail});
    const safely = async (name: string, fn: () => Promise<void>) => {
        try {
            await fn();
        } catch (e) {
            add(name, 'fail', `could not run: ${e?.message || e}`);
        }
    };
    const provider = staticProvider(stakingRpcUrl());
    const head = await withRateRetry(() => provider.getBlockNumber());
    const eventCursor = await getStakingCursor();
    const opt = blockRewardOption();
    const blockCursor = await getBlockRewardCursor();

    add('strict mode', stakingOption().strict ? 'pass' : 'fail',
        stakingOption().strict ? 'on' : 'off: approximations and unknowns may have been recorded');

    // events
    add('events caught up', head - eventCursor <= HEAD_LAG ? 'pass' : 'fail', `event cursor ${eventCursor}, head ${head}`);
    await safely('implementation upgrades', async () => {
        const n = await StakingEvent.count({where: {eventType: StakingEventType.ImplementationUpgraded}});
        const tracked = await KV.getString('STAKING_BEACON_UPGRADES', '');
        add('implementation upgrades', tracked && tracked === trackedBeacon() && n > 0 ? 'pass' : 'fail',
            `${n} upgrades of beacon ${tracked || '(not backfilled)'}`);
    });
    await safely('shares vs chain', async () => {
        const r = await reconcileAllShares(eventCursor, {dryRun: true, alert: false});
        add('shares vs chain', r.mismatched ? 'fail' : 'pass', `${r.checked} delegations at ${eventCursor}, ${r.mismatched} differ`);
    });
    await safely('exit settlements', async () => {
        // an exit synced before exits were told apart carries no implementation at all
        const row = await one(`select count(*) as n,
                sum(json_unquote(json_extract(extra, '$.implementation')) is null) as unclassified,
                sum(json_unquote(json_extract(extra, '$.implementation')) = 'stake-to-commission') as old,
                sum(json_unquote(json_extract(extra, '$.implementation')) = 'stake-to-commission'
                    and (json_extract(extra, '$.exitSettlement') is null or json_type(json_extract(extra, '$.exitSettlement')) = 'NULL')) as unknown
            from ${StakingEvent.getTableName()} where eventType = ?`, [StakingEventType.ValidatorExited]);
        const bad = Number(row.unclassified || 0) + Number(row.unknown || 0);
        add('exit settlements', bad ? 'fail' : 'pass', `${row.n} exits: ${Number(row.old || 0)} old-implementation, `
            + `${Number(row.unknown || 0)} with the settlement unknown, ${Number(row.unclassified || 0)} never classified (resync events)`);
    });

    if (!opt.enabled) {
        add('block rewards', 'skip', 'blockRewards.enabled is off');
        return {pass: !checks.some(c => c.status === 'fail'), checks};
    }

    // per-block data
    add('blocks caught up', eventCursor - blockCursor <= HEAD_LAG ? 'pass' : 'fail', `block cursor ${blockCursor}, event cursor ${eventCursor}`);
    await safely('block coverage', async () => {
        const row = await one(`select count(*) as n, min(blockNumber) as lo, max(blockNumber) as hi from ${StakingBlockReward.getTableName()}`);
        const expected = blockCursor - opt.startBlock + 1;
        const ok = Number(row.n) === expected && Number(row.lo) === opt.startBlock && Number(row.hi) === blockCursor;
        add('block coverage', ok ? 'pass' : 'fail', `${row.n} rows for ${expected} blocks ${opt.startBlock}-${blockCursor} (stored ${row.lo}-${row.hi})`);
    });
    await safely('consensus-layer reconciliation', async () => {
        const r = await reconcileBlockRewards();
        add('consensus-layer reconciliation', r == null ? 'fail' : r.ok ? 'pass' : 'fail', r ? r.message : 'no baseline or no endpoint, so it was never checked');
    });
    await safely('daily totals', async () => {
        const cols = ['reward', 'communityTax', 'commission', 'undistributed', 'restakingReward', 'foundationReward'];
        const sums = cols.map(c => `cast(coalesce(sum(${c}), 0) as char) as ${c}`).join(', ');
        const [d, b] = await Promise.all([
            one(`select cast(coalesce(sum(blockCount), 0) as char) as n, ${sums} from ${StakingRewardDaily.getTableName()}`),
            one(`select count(*) as n, ${sums} from ${StakingBlockReward.getTableName()}`),
        ]);
        const bad = ['n', ...cols].filter(c => String(d[c]) !== String(b[c]));
        const [rd, rb] = await Promise.all([
            one(`select cast(coalesce(sum(blockCount), 0) as char) as n, cast(coalesce(sum(amount), 0) as char) as a from ${StakingRestakingDaily.getTableName()}`),
            one(`select count(*) as n, cast(coalesce(sum(restakingReward), 0) as char) as a from ${StakingBlockReward.getTableName()} where restakingReward > 0`),
        ]);
        if (String(rd.n) !== String(rb.n) || String(rd.a) !== String(rb.a)) bad.push('restaking daily');
        add('daily totals', bad.length ? 'fail' : 'pass', bad.length ? `differ from the per-block table: ${bad.join(', ')}` : 'both daily tables equal the per-block table');
    });
    await safely('owner qualification', async () => {
        const row = await one(`select count(*) as n, sum(source = 'approx') as approx from ${StakingSelfDelegation.getTableName()} where stateBlock is not null`);
        add('owner qualification', Number(row.approx || 0) ? 'fail' : 'pass', `${row.n} evaluations, ${Number(row.approx || 0)} approximated`);
    });
    await safely('commission checkpoints', async () => {
        // close the last window at the cursor so every collected block is covered
        await commissionCheckOnce(blockCursor, true);
        const row = await one(`select min(blockNumber) as lo, max(blockNumber) as hi, sum(status = 'ok') as ok,
                sum(status = 'mismatch') as mismatch, sum(status = 'unknown') as unknown, count(distinct blockNumber) as points
            from ${StakingCommissionCheck.getTableName()}`);
        const fromStart = Number(row.lo) <= opt.startBlock - 1;
        const ok = fromStart && Number(row.hi) === blockCursor && !Number(row.mismatch) && !Number(row.unknown);
        add('commission checkpoints', ok ? 'pass' : 'fail',
            `${row.points} checkpoints ${row.lo}-${row.hi}${fromStart ? '' : ` (not from ${opt.startBlock - 1}: earlier blocks unchecked)`}; `
            + `${Number(row.ok || 0)} ok, ${Number(row.mismatch || 0)} mismatch, ${Number(row.unknown || 0)} unknown`);
    });
    await safely('slashes vs consensus layer', async () => {
        const ours = new Set((await StakingBlockSlash.findAll({raw: true, attributes: ['validator']})).map(r => r.validator));
        const url = validatorRpcUrl();
        if (!url) {
            add('slashes vs consensus layer', 'skip', `no consensus-layer validators endpoint; ${ours.size} slashed validators recorded`);
            return;
        }
        const json: any = await (await fetch(url)).json();
        const cl = new Set<string>((json.data || []).filter(v => v.validator?.slashed)
            .map(v => '0x' + String(v.validator.withdrawal_credentials).slice(-40).toLowerCase()));
        const missing = [...cl].filter(a => !ours.has(a)), extra = [...ours].filter(a => !cl.has(a));
        add('slashes vs consensus layer', missing.length || extra.length ? 'fail' : 'pass',
            `consensus layer marks ${cl.size} slashed, ${ours.size} recorded` + (missing.length ? `; not recorded: ${missing.join(',')}` : '')
            + (extra.length ? `; not marked slashed: ${extra.join(',')}` : ''));
    });
    await safely('slash share accounting', async () => {
        // strict mode records, for each slashed (validator, block), the shares the slash took
        const row = await one(`select count(*) as slashed,
                sum(exists(select 1 from ${StakingEvent.getTableName()} e where e.validator = s.validator and e.blockNumber = s.blockNumber
                    and e.eventType = ? and json_unquote(json_extract(e.extra, '$.source')) = 'block-slash')) as accounted
            from (select distinct validator, blockNumber from ${StakingBlockSlash.getTableName()}) s`, [StakingEventType.SlashDetected]);
        const missing = Number(row.slashed) - Number(row.accounted || 0);
        add('slash share accounting', missing ? 'fail' : 'pass', `${row.slashed} slashed (validator, block), ${missing} without the owner's share change recorded`);
    });
    await safely('foundation address', async () => {
        const others = await otherFoundationAddresses();
        add('foundation address', others.length ? 'fail' : 'pass', others.length ? `withdrawals[2] also went to ${others.join(', ')}` : `always ${opt.foundationAddress}`);
    });
    await safely('community tax rate', async () => {
        const seen = await KV.getString('STAKING_COMMUNITY_TAX_RATE_SEEN', '');
        add('community tax rate', seen === String(opt.communityTaxRate) ? 'pass' : 'fail', `chain ${seen || '(never read)'}, configured ${opt.communityTaxRate}`);
    });
    await safely('community pool history', async () => {
        const h = await communityPoolHistory();
        const approx = h ? h.pools.filter(p => p.approx).length : 0;
        const ok = h && h.pools[0]?.fromBlock === opt.startBlock && h.checkedTo === blockCursor && !approx;
        add('community pool history', ok ? 'pass' : 'fail', !h ? 'never tracked' : `${h.pools.map(p => `${p.address} from ${p.fromBlock}`).join(', ')}; `
            + `checked to ${h.checkedTo} (cursor ${blockCursor})${approx ? `, ${approx} change(s) only approximately placed` : ''}`);
    });
    return {pass: !checks.some(c => c.status === 'fail'), checks};
}
