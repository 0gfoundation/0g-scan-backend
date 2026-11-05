import {safeAddErrorLog} from "../../monitor/ErrorMonitor";
import {init} from "../tool/FixDailyTokenStat";
import {regExitHook} from "../tool/ProcessTool";
import {diffWithXangle} from "./StakingDiff";
import {reconcileAllShares, runStakingRefresher, stakingRefreshOnce} from "./StakingRefresher";
import {getStakingCursor, initStakingSync, runStakingSync, stakingOption, stakingSyncOnce} from "./StakingSync";

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
    console.log(`staking index started`);
}

/**
 * node stat/service/staking/StakingMain.js <command>
 *   sync              run the sync until caught up once, then exit
 *   refresh           one refresh round, including a full reconciliation
 *   reconcile         full reconciliation at the cursor block only
 *   diff <xangleDir>  compare with the Xangle indexer's Mongo exports
 * These ignore `staking.enabled` but need the rest of `config.staking`.
 */
async function main() {
    const [cmd, arg] = process.argv.slice(2);
    await init();
    if (cmd === 'diff') {
        await diffWithXangle(arg);
        return;
    }
    await initStakingSync();
    if (cmd === 'sync') {
        while (!(await stakingSyncOnce())) {
            // loop until caught up
        }
        console.log(`caught up at ${await getStakingCursor()}`);
    } else if (cmd === 'refresh') {
        // the share checks read state at the cursor block, so it must be near the head
        while (!(await stakingSyncOnce())) {
            // loop until caught up
        }
        await stakingRefreshOnce({fullReconcile: true});
    } else if (cmd === 'reconcile') {
        await reconcileAllShares(await getStakingCursor());
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
