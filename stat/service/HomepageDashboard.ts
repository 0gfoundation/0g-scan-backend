import {ADDRESS_COUNT_ALL, CONTRACT_COUNT_ALL, KEY_FULL_TX_COUNT, KEY_GAS_USED_PER_SECOND, KV} from "../model/KV";
import {AddressTransactionIndex, FullBlock} from "../model/FullBlock";
import {CONST} from "./common/constant"
import {hex40IdMap} from "../model/HexMap";
import {PruneInfo, PruneType} from "../model/PruneInfo";
import {Conflux} from "js-conflux-sdk";
import {SupplyInfo} from "js-conflux-sdk/dist/types/rpc/types/formatter";
import {ConfigInstance} from "../config/StatConfig";
import {calculateEvmPosSupply} from "./ZGSupply";

const lodash = require('lodash');

export class HomepageDashboard {
    private app: {cfx: Conflux};
    private static data = {
        internalContractInfo: {},
        blockchainInfo: {},
        supplyInfo: {},
        dagInfo: {},
    };

    constructor(app: {cfx: Conflux}) {
        this.app = app;
        this.schedule().then();
    }

    static getData() {
        return {...HomepageDashboard.data};
    }

    private async schedule(delay: number = 3000) {
        const that = this;

        async function repeat() {
            await that.run().catch(err => {
                console.log('Schedule home dashboard service fail', err);
            });
            setTimeout(repeat, delay);
        }

        repeat().then();
        console.log(`Schedule home dashboard service with delay: ${delay}`);
    }

    async internalContractInfo() {
        const hexIdMap = await hex40IdMap(CONST.INTERNAL_CONTRACT);

        const result = {};
        for (const [hex, addressId] of hexIdMap.entries()) {
            const count = await AddressTransactionIndex.count({where: {addressId}});
            const pruneInfo = await PruneInfo.findOne({where: {addressId, type: PruneType.ADDR_TX}});
            result[`0x${hex}`] = count + (pruneInfo?.pruned || 0);
        }

        return result;
    }

    private async blockchainInfo() {
        const {
            app: {cfx},
        } = this;

        const [addressCount, transactionCount, contractCount, gasUsedInfo, maxBlock, status] = await Promise.all([
            KV.getNumber(ADDRESS_COUNT_ALL, 0),
            KV.getNumber(KEY_FULL_TX_COUNT, 0),
            KV.getNumber(CONTRACT_COUNT_ALL, 0),
            KV.getString(KEY_GAS_USED_PER_SECOND, ''),
            FullBlock.findOne({order: [['epoch', 'desc']]}),
            cfx.getStatus().catch(() => undefined),
        ])

        return {
            addressCount,
            transactionCount,
            contractCount,
            epochNumber: maxBlock?.epoch,
            blockNumber: status?.blockNumber,
            gasUsedPerSecond: gasUsedInfo ? Number((JSON.parse(gasUsedInfo)).gasUsedPerSecond) : undefined,
        };
    }

    private async supplyInfo() {
        const {
            app: {cfx},
        } = this;

        const [supplyInfo, nullAddressBalance] = await Promise.all([
            cfx.getSupplyInfo(),
            cfx.getBalance(CONST.ZERO_ADDRESS),
        ])

        const patchedInfo = await patchSupplyInfo(supplyInfo, nullAddressBalance.valueOf());

        return {
            ...supplyInfo,
            ...patchedInfo,
            ...(patchedInfo?.calculateEvmPosSupply ? undefined : {twoYearUnlockBalance: 0n, fourYearUnlockBalance: 0n}),
            nullAddressBalance,
        }
    }

    async dagInfo({limit = 10} = {}) {
        const {
            app: {cfx},
        } = this;

        const epochNumber = await cfx.getEpochNumber(CONST.EPOCH_NUMBER.LATEST_STATE).then((num: number) => {
            return num - 5;
        });

        const list = await Promise.all(lodash.range(limit).map(async (index: number) => {
            const blockHashes = await cfx.getBlocksByEpochNumber(epochNumber - index);
            const blocks = await Promise.all(blockHashes.map((hash: string) => cfx.getBlockByHash(hash)));
            return [...blocks].reverse();
        })).catch(e => {
            if (e.code === -32602) { //  Invalid params: expected a numbers with less than largest epoch number.
                return undefined;
            }
            throw e;
        });

        if (!list) {
            return undefined;
        }

        return {total: epochNumber, list};
    }

    private async run() {
        const data = HomepageDashboard.data;
        data.internalContractInfo = {
            ...data.internalContractInfo,
            ...(await this.internalContractInfo()),
        };
        data.blockchainInfo = {
            ...data.blockchainInfo,
            ...(await this.blockchainInfo()),
        };
        data.supplyInfo = {
            ...data.supplyInfo,
            ...(await this.supplyInfo().catch(e => console.log(`${__filename} supply info error:`, e))),
        };
        data.dagInfo = {
            ...data.dagInfo,
            ...(await this.dagInfo().catch(e => console.log(`${__filename} dag info error:`, e))),
        };
    }
}

/**
 * `balance(0x0)` in drip, which comes off the gross figures to give the published ones:
 *
 *     total       = total_CL + total_EL
 *     total_CL    = totalStakes
 *     total_EL    = genesisSupply + sumBlockWithdrawal - nullAddressBalance
 *     circulating = total - sumContracts
 *
 * i.e. `total = totalIssued - nullStakeDrip()` and
 * `circulating = totalCirculating - nullStakeDrip()`, since `calculateEvmPosSupply()`
 * reports `totalIssued = genesis + blockWithdraw + totalStakes` and
 * `totalCirculating = totalIssued - sumContracts`. On 0G staking burns into 0x0 on the
 * execution side and mints on the consensus side, so 0x0 is taken off the execution
 * layer in full.
 *
 * The whole balance is subtracted whatever the other terms read. When `validatorRpc`
 * fails, `totalStakes` reads 0 and these figures drop by the staked amount -- that was
 * seen on mainnet (circulating 707M -> 190M) -- so watch `validatorMessage`.
 *
 * Core space is the same subtraction: there `getSupplyInfo()` answers for itself.
 */
export function nullStakeDrip(supplyInfo: any): bigint {
    return BigInt(supplyInfo?.nullAddressBalance || 0);
}

export async function patchSupplyInfo(supplyInfo: SupplyInfo, balanceOfZero: bigint): Promise<SupplyInfo&any> {
    if (supplyInfo?.totalCirculating == 0n && ConfigInstance.noCoreSpace && ConfigInstance.isEvm) {
        return calculateEvmPosSupply(balanceOfZero);
    } else {
        return supplyInfo;
    }
}