import {safeAddErrorLog} from "../../monitor/ErrorMonitor";
import {init} from "../tool/FixDailyTokenStat";
import {regExitHook} from "../tool/ProcessTool";
import {diffWithXangle} from "./StakingDiff";
import {reconcileAllShares, runStakingRefresher, stakingRefreshOnce} from "./StakingRefresher";
import {ethers} from "ethers";
import {QueryTypes} from "sequelize";
import {ConfigInstance} from "../../config/StatConfig";
import {StakingBlockReward, StakingEvent, StakingEventType} from "../../model/Staking";
import {getBlockRewardCursor, reconcileBlockRewards, runStakingBlockSync, stakingBlockSyncOnce} from "./StakingBlockSync";
import {VALIDATOR_ABI} from "./StakingAbi";
import {commissionCheckOnce} from "./StakingCheck";
import {
    blockRewardOption,
    getStakingCursor,
    initStakingSync,
    runStakingSync,
    stakingOption,
    stakingSyncOnce,
} from "./StakingSync";

/**
 * Started from TokenMiscSync (the `token_x` container) when
 * `config.staking.enabled` is set. A misconfiguration is reported and the rest
 * of token_x keeps running.
 */
export async function startStaking() {
    if (!stakingOption().enabled) {
        return;
    }
    try {
        await initStakingSync();
    } catch (e) {
        console.log(`staking index not started:`, e?.message || e);
        safeAddErrorLog('staking', 'init', e);
        return;
    }
    runStakingSync().then();
    runStakingRefresher().then();
    if (blockRewardOption().enabled) {
        runStakingBlockSync().then();
    }
    console.log(`staking index started${blockRewardOption().enabled ? ', with block rewards' : ''}`);
}

/**
 * node stat/service/staking/StakingMain.js <command>
 *   sync              run the sync until caught up once, then exit
 *   refresh           one refresh round, including a full reconciliation
 *   reconcile         full reconciliation at the cursor block only
 *   diff <xangleDir>  compare with the Xangle indexer's Mongo exports
 *   blocks            collect block rewards until caught up with the event sync, then reconcile
 *   check             write a commission / tax-rate checkpoint at the block-reward cursor now
 *                     and compare it with the previous one (needs state at the cursor block)
 *   check-commission <validator> <fromBlock> <toBlock>
 *                     compare the collected commission over [from, to] with chain state
 *                     (needs an RPC that serves state at those blocks)
 * These ignore `staking.enabled` / `blockRewards.enabled` but need the rest of the config.
 */
async function main() {
    const [cmd, arg, arg2, arg3] = process.argv.slice(2);
    await init();
    if (cmd === 'diff') {
        await diffWithXangle(arg);
        return;
    }
    await initStakingSync();
    if (cmd === 'sync') {
        await untilCaughtUp(stakingSyncOnce, 'sync');
        console.log(`caught up at ${await getStakingCursor()}`);
    } else if (cmd === 'refresh') {
        // the share checks read state at the cursor block, so it must be near the head
        await untilCaughtUp(stakingSyncOnce, 'sync');
        await stakingRefreshOnce({fullReconcile: true});
    } else if (cmd === 'reconcile') {
        await reconcileAllShares(await getStakingCursor());
    } else if (cmd === 'blocks') {
        let rounds = 0;
        await untilCaughtUp(async () => {
            const done = await stakingBlockSyncOnce();
            if (++rounds % 20 === 0) console.log(`block rewards at ${await getBlockRewardCursor()}`);
            return done;
        }, 'blocks');
        console.log(`block rewards caught up at ${await getBlockRewardCursor()}`);
        console.log(`reconciliation:`, await reconcileBlockRewards());
    } else if (cmd === 'check') {
        const r = await commissionCheckOnce(await getBlockRewardCursor(), true);
        console.log(r ? JSON.stringify(r, null, 2) : 'nothing to check: no new collected blocks since the last checkpoint');
    } else if (cmd === 'check-commission') {
        await checkCommission(arg.toLowerCase(), Number(arg2), Number(arg3));
    } else {
        console.log(`unknown command [${cmd}], see the comment on main() in ${__filename}`);
    }
}

if (module === require.main) {
    // no redirectLog: these are interactive, the output belongs on the terminal
    regExitHook();
    main().then(() => process.exit(0)).catch(e => {
        console.log(e);
        process.exit(1);
    });
}

/**
 * Chain view: commission() after toBlock - commission() after fromBlock - 1,
 * plus what was withdrawn in between (a withdrawal zeroes commission()).
 * Ours: the per-block commission collected for those blocks.
 */
async function checkCommission(validator: string, from: number, to: number) {
    const c = new ethers.Contract(validator, VALIDATOR_ABI, new ethers.providers.JsonRpcProvider(ConfigInstance.ether.url));
    const [before, after] = await Promise.all([c.commission({blockTag: from - 1}), c.commission({blockTag: to})]);
    const [w]: any[] = await StakingEvent.sequelize.query(
        `select cast(coalesce(sum(amount), 0) as char) as s from ${StakingEvent.getTableName()}
         where validator = ? and eventType = ? and blockNumber between ? and ?`,
        {type: QueryTypes.SELECT, replacements: [validator, StakingEventType.WithdrawCommission, from, to]});
    const [ours]: any[] = await StakingBlockReward.sequelize.query(
        `select cast(coalesce(sum(commission), 0) as char) as s, count(*) as n from ${StakingBlockReward.getTableName()}
         where validator = ? and blockNumber between ? and ?`,
        {type: QueryTypes.SELECT, replacements: [validator, from, to]});
    const chain = BigInt(after.toString()) - BigInt(before.toString()) + BigInt(w.s);
    console.log(JSON.stringify({
        validator, from, to, blocksProposed: Number(ours.n),
        chainAccrued: chain.toString(), collected: ours.s, match: chain === BigInt(ours.s),
        commissionBefore: before.toString(), commissionAfter: after.toString(), withdrawn: w.s,
    }, null, 2));
}

/**
 * Runs one round at a time until it reports caught up. A failed round (most
 * often a transient RPC error) is retried with backoff instead of ending the
 * command; rounds are transactional, so a retry starts from the saved cursor.
 */
async function untilCaughtUp(round: () => Promise<boolean>, label: string) {
    let failures = 0;
    for (;;) {
        try {
            if (await round()) {
                return;
            }
            failures = 0;
        } catch (e) {
            if (++failures > 10) {
                throw e;
            }
            console.log(`${label} round failed (${failures}/10), retrying:`, e?.message || e);
            await new Promise(r => setTimeout(r, 2000 * failures));
        }
    }
}
