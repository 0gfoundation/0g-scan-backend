// import {ConfluxOption} from "js-conflux-sdk";
import {ISingleHostConfig} from "influx";
import * as os from "os";
import {Options} from "sequelize";

const fs = require('fs')
const templateConf = require('./Template')

export interface ConfluxOption {
    url: string,
    timeout?: number,
    networkId?: number,
    logger?: object,
    defaultGasPrice?: number,
    defaultGasRatio?: number,
    defaultStorageRatio?: number,
    consortiumMode?: boolean, // true: consortium chain; false: public chain
    keepAlive?: boolean,
}
export interface EtherOption {
    url: string,
}
/** 0G validator/delegation index, see document/staking/PLAN.md */
export interface StakingOption {
    enabled?: boolean, // default false
    contract?: string, // default: STAKING_CONTRACT_ADDRESS from ValidatorContract.sol
    /**
     * Which built-in genesis validator list to seed: 'mainnet' | 'testnet' | 'none'
     * (GENESIS_VALIDATORS in StakingAbi.ts). Required when enabled: validators
     * registered via genesis deposits emit no event, so the sync refuses to
     * start without an explicit choice.
     */
    genesis?: string,
    startBlock?: number, // first block to scan, default 1
    confirmations?: number, // blocks kept back from latest, default 0 (CometBFT finalizes each block)
    logRange?: number, // blocks per eth_getLogs window, default 100,000 (the 0G RPC's cap)
    refreshIntervalMs?: number, // default 60s
    // the validators' UpgradeableBeacon; default: the Staking contract's validatorBeacon()
    validatorBeacon?: string,
    /** per-block rewards, commission, community tax, foundation rewards and slashes */
    blockRewards?: {
        enabled?: boolean, // default false
        // first block to collect; mainnet withdrawals start at 10,877,918. A later
        // start only covers part of the history: cumulative figures then count from it.
        startBlock?: number,
        batchSize?: number, // blocks per JSON-RPC batch, default 50 (the 0G RPCs reject more)
        concurrency?: number, // batches in flight, default 2
        foundationAddress?: string, // expected withdrawals[2].address, default 0x711b...2522
        communityTaxRate?: number, // raw, 1e6 = 100%; default 100000 (10%)
        // consensus layer .../blocks/{id}/total_withdrawals; default: validatorRpc
        clTotalWithdrawalsUrl?: string,
        // seconds of chain time between commission/tax-rate checkpoints, default 3600
        checkIntervalSec?: number,
        // alert when the collected head is older than this, once caught up; default 600
        freshnessAlertSec?: number,
    },
}
export interface ConsortiumBridgeOption {
    port: number,
    retry: number,
    rpc: ConfluxOption,
}
export interface Database{
    host: string;
    port: number;
    user: string;
    pwd: string;
    database: string;
    blockTableRowsLimit: number;
    syncSchema: boolean;
    readonly : boolean;
}
export interface DatabaseRW extends Options {
    instanceName: string;
}

export interface OssConf {
    region?: string;
    accessId: string
    accessKey: string
    bucket: string
    prefix: string // mainnet testnet dev stress pos
}
export interface JSONRpcOption {
    url: string,
    proxy: object,
}
export interface SyncQuoteOption{
    open: boolean;
    interval: {
        bn: number,
        cmc: number,
        moonswap: number,
        swappi: number,
        peer: number,
    },
}
export interface StatConfig{
    useGetLogs: boolean;
    getLogsRange?: number;
    getLogsJobCount?: number;
    getLogsDbBatchSize?: number;
    influxDB?: ISingleHostConfig & {measurement: string, disable?: boolean}
    oss: OssConf
    firstBlockNo: number
    noCoreSpace: boolean
    pendingTxNotAvailable: boolean
    traceNotAvailable: boolean,
    dingTalkToken: string;
    dingDevToken: string;
    tgToken?: string; //telegram
    tgChatId?: string //telegram
    port: number;
    apiPort: number;
    v1port: number; // scan-api port, for path /v1
    diffMonitorPort?:number; // -9000 to disable
    billingApp: string;
    conflux: ConfluxOption; // chain rpc node
    blockSyncRpc: ConfluxOption; // chain rpc node
    conflux2?: ConfluxOption; // get cross space info in eSpace, needless in coreSpace
    ether: EtherOption;
    cfxTransferRpc?: ConfluxOption; // for cfx transfer sync
    tokenTransferRpc?: ConfluxOption; // for token transfer sync
    consortiumBridge?: ConsortiumBridgeOption;
    cfxWsUrl: string
    preload: number,
    scanApiUrl: string
    isEvm: boolean,
    scanJsonRpcUrl: string
    database: Database;
    serverTag: string,
    watchCfxBalance: boolean,
    recaptchaUrl:string,
    recaptchaToken:string,
    reportUrl: string,
    // Consensus layer cumulative withdrawals and issuance, the only external input the
    // published supply depends on:
    //   http://<beacon host>/eth/v1/beacon/blocks/head/total_withdrawals
    // Named for the validators endpoint it used to point at, which fed a staked figure
    // nothing publishes any more.
    validatorRpc?: string,
    staking?: StakingOption,

    syncIPFSGateway: boolean,
    syncIPFSGatewayDelay: number,

    syncQuote: SyncQuoteOption,
    quoteConvertSymbolArray: Array<string>,
    marketCapToken: string,
    binanceToken: string,

    syncTokenSecurityAudit: boolean,
    noTopToken: boolean,
    onlyStatActiveContract: boolean,
    blacklist: boolean,

    databaseRW: DatabaseRW,
    metricsEnv: string,

    ensEnable: boolean,
    ens: string,
    reverseRegistrar: string,
    baseRegistrar: string,
    ensChecker: string,
    reverseRecords: string,

    tldOpenapi: string, // top level domain of open api

    censorAppId: string,
    censorApiKey: string,
    censorSecretKey: string,

    asyncWrappedToken: boolean,
    wrappedUSDT: string,
    wrappedUSDT0: string,
    wrappedCFX: string,
    wrappedBTC: string,

    enableProfile: boolean,

    contractVerificationUrl: string,
    verifyByAuto: boolean,
}

export var FirstBlockNo = 0
// for chains without core space
export var NoCoreSpace = false

export var CoreDB = 'conflux_scan';
export var EvmDB = "evm";
export var Cfg_is_EVM: boolean = null;
export var ConfigInstance: StatConfig;
/**
 *  Priority from low to high: template.js -> local.js -> specified.js
 */
export function loadConfig(specified:string = undefined): StatConfig {
    let path = `${__dirname}/Local.js`;
    let defaultConf = {default:{firstBlockNo: 0, noCoreSpace: false, coreDB: 'conflux_scan', evmDB: 'evm', isEvm: null}}
    if (fs.existsSync(path)){
        defaultConf = require('./Local')
    }

    let specific = specified === undefined ? {default:{}} : require(`./${specified}`)
    // console.log(`template is 0 `, templateConf.default)
    // console.log(`specific is `, specific)
    const conf = {...templateConf.default, ...defaultConf.default, ...specific.default}
    FirstBlockNo = conf.firstBlockNo
    NoCoreSpace = conf.noCoreSpace
    CoreDB = conf.coreDB;
    EvmDB = conf.evmDB;
    Cfg_is_EVM = conf.isEvm;
    if(conf?.consortiumBridge) {
        console.log(`web port [${conf.consortiumBridge.port}] rpc [`, conf.consortiumBridge.rpc, `]`)
        return conf;
    }
    conf.serverTag = `${conf.serverTag}@${os.hostname()}`
    console.log(`------ /stat api port [${conf.port}]. --------`)
    ConfigInstance = conf;
    return conf;
}
