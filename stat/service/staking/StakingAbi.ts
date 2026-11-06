import {ethers} from "ethers";
import {StakingEventType} from "../../model/Staking";

/**
 * Event signatures and decoding for the 0G staking contracts
 * (`common/contracts/gravity`).
 *
 * Decoding is defensive: a log whose topic count or data length does not match
 * any known shape is reported and skipped, never thrown, so one odd log cannot
 * stall the sync cursor.
 */

/** Hardcoded in ValidatorContract.sol as STAKING_CONTRACT_ADDRESS. */
export const DEFAULT_STAKING_CONTRACT = '0xea224dbb52f57752044c0c86ad50930091f561b9';

const id = ethers.utils.id;

export const TOPIC = {
    // Staking contract
    ValidatorCreated: id('ValidatorCreated(bytes,address)'),
    ValidatorInitialized: id('ValidatorInitialized(bytes,address,address,uint256)'),
    ValidatorExited: id('ValidatorExited(bytes,address)'),
    // validator contracts. V1 is the pre-upgrade signature: its delegator is
    // topics[1] when indexed, or the first data word when not.
    DelegateV1: id('Delegate(address,uint256,uint256)'),
    UndelegateV1: id('Undelegate(address,uint256,uint256)'),
    DelegateV2: id('Delegate(address,address,uint256,uint256)'),
    UndelegateV2: id('Undelegate(address,address,uint256,uint256)'),
    OwnershipTransferred: id('OwnershipTransferred(address,address)'),
    CommissionRateChanged: id('CommissionRateChanged(uint32,uint32)'),
    WithdrawalFeeInGweiChanged: id('WithdrawalFeeInGweiChanged(uint96,uint96)'),
    WithdrawCommission: id('WithdrawCommission(address,address,uint256)'),
    WithdrawTipFee: id('WithdrawTipFee(address,address,uint256)'),
    // fetched only to tell the two exit implementations apart, never stored (see StakingSync)
    Exited: id('Exited(address)'),
};

export const STAKING_TOPICS = [TOPIC.ValidatorCreated, TOPIC.ValidatorInitialized, TOPIC.ValidatorExited];

export const VALIDATOR_TOPICS = [
    TOPIC.DelegateV1, TOPIC.UndelegateV1, TOPIC.DelegateV2, TOPIC.UndelegateV2,
    TOPIC.OwnershipTransferred, TOPIC.CommissionRateChanged, TOPIC.WithdrawalFeeInGweiChanged,
    TOPIC.WithdrawCommission, TOPIC.WithdrawTipFee, TOPIC.Exited,
];

/**
 * Not listened to: DistributeRewards, PopWithdrawEntry and the failed-requeue
 * PushWithdrawEntry, which system calls emit and `eth_getLogs` does not
 * return; and Slashed, which is not recorded by decision (slashes come from
 * the blocks' slashed arrays). See PLAN.md "事件清单".
 *
 * The validator contracts' Exited is fetched but not stored: a validator's
 * exit is the Staking contract's ValidatorExited, and Exited only shows which
 * implementation handled it (only the newer one emits it).
 */

export const VALIDATOR_ABI = [
    'function owner() view returns (address)',
    'function operatorAddress() view returns (address)',
    'function consensusPubkey() view returns (bytes)',
    'function description() view returns (string, string, string, string, string)',
    'function commissionRate() view returns (uint32)',
    'function withdrawalFeeInGwei() view returns (uint96)',
    'function tokens() view returns (uint256)',
    'function rewards() view returns (uint256)',
    'function delegatorShares() view returns (uint256)',
    'function commission() view returns (uint256)',
    'function tipFee() view returns (uint256)',
    'function stakes() view returns (uint256)',
    'function annualPercentageYield() view returns (uint64)',
    'function bondStatus() view returns (uint8)',
    'function minSelfDelegationInGwei() view returns (uint96)',
    'function getDelegation(address) view returns (address, uint256)',
    'function getDelegatedTokens(address) view returns (uint256)',
];

export interface RawLog {
    address: string
    topics: string[]
    data: string
    blockNumber: number
    blockHash: string
    transactionHash: string
    transactionIndex: number
    logIndex: number
}

export interface DecodedStakingEvent {
    eventType: StakingEventType
    validator: string
    account?: string
    counterparty?: string
    amount?: string
    shares?: string
    extra?: object
}

function topicAddr(topic: string): string | null {
    // an address topic is 12 zero bytes + 20 address bytes
    if (!topic || topic.length !== 66 || !/^0x0{24}/i.test(topic)) {
        return null;
    }
    return ('0x' + topic.slice(26)).toLowerCase();
}

function words(data: string): string[] {
    const hex = (data || '0x').slice(2);
    const ret = [];
    for (let i = 0; i + 64 <= hex.length; i += 64) {
        ret.push('0x' + hex.slice(i, i + 64));
    }
    return ret;
}

function wordUint(w: string): string {
    return BigInt(w).toString();
}

function wordAddr(w: string): string | null {
    return topicAddr(w);
}

export class StakingDecodeError extends Error {
}

function bad(log: RawLog, why: string): never {
    throw new StakingDecodeError(`${why}, tx ${log.transactionHash} log ${log.logIndex} topics ${log.topics.length} data ${(log.data.length - 2) / 2}B`);
}

/**
 * Decodes one log. Returns null for topics this module does not know, and
 * throws StakingDecodeError for a known topic with an unexpected shape -- the
 * caller logs and skips it.
 */
export function decodeStakingLog(log: RawLog): DecodedStakingEvent | null {
    const t = log.topics;
    const emitter = log.address.toLowerCase();
    const w = words(log.data);
    switch (t[0]) {
        case TOPIC.ValidatorCreated: {
            // (bytes indexed pubkey, address indexed validator): topics[1] is keccak(pubkey)
            const validator = topicAddr(t[2]);
            if (t.length !== 3 || !validator) bad(log, 'ValidatorCreated');
            return {eventType: StakingEventType.ValidatorCreated, validator, extra: {pubkeyHash: t[1]}};
        }
        case TOPIC.ValidatorInitialized: {
            // (bytes indexed pubkey, address indexed validator, address operator, uint amount)
            const validator = topicAddr(t[2]);
            const operator = w.length >= 2 ? wordAddr(w[0]) : null;
            if (t.length !== 3 || !validator || !operator) bad(log, 'ValidatorInitialized');
            return {
                eventType: StakingEventType.ValidatorInitialized, validator,
                account: operator, amount: wordUint(w[1]), extra: {pubkeyHash: t[1]},
            };
        }
        case TOPIC.ValidatorExited: {
            const validator = topicAddr(t[2]);
            if (t.length !== 3 || !validator) bad(log, 'ValidatorExited');
            return {eventType: StakingEventType.ValidatorExited, validator, extra: {pubkeyHash: t[1]}};
        }
        case TOPIC.DelegateV1: {
            // indexed: topics[1] = delegator, data = [amount, shares]
            // not indexed: data = [delegator, amount, shares]
            let delegator: string, rest: string[];
            if (t.length === 2 && w.length >= 2) {
                delegator = topicAddr(t[1]);
                rest = w;
            } else if (t.length === 1 && w.length >= 3) {
                delegator = wordAddr(w[0]);
                rest = w.slice(1);
            }
            if (!delegator) bad(log, 'Delegate V1');
            return {
                eventType: StakingEventType.Delegate, validator: emitter, account: delegator,
                amount: wordUint(rest[0]), shares: wordUint(rest[1]), extra: {v: 1},
            };
        }
        case TOPIC.DelegateV2: {
            // (address indexed payer, address indexed delegator, uint amount, uint shares)
            const payer = topicAddr(t[1]);
            const delegator = topicAddr(t[2]);
            if (t.length !== 3 || !payer || !delegator || w.length < 2) bad(log, 'Delegate V2');
            return {
                eventType: StakingEventType.Delegate, validator: emitter, account: delegator,
                counterparty: payer, amount: wordUint(w[0]), shares: wordUint(w[1]),
            };
        }
        case TOPIC.UndelegateV1: {
            // indexed: topics[1] = delegator, data = [shares, amount]
            // not indexed: data = [delegator, shares, amount]
            let delegator: string, rest: string[];
            if (t.length === 2 && w.length >= 2) {
                delegator = topicAddr(t[1]);
                rest = w;
            } else if (t.length === 1 && w.length >= 3) {
                delegator = wordAddr(w[0]);
                rest = w.slice(1);
            }
            if (!delegator) bad(log, 'Undelegate V1');
            return {
                eventType: StakingEventType.Undelegate, validator: emitter, account: delegator,
                shares: wordUint(rest[0]), amount: wordUint(rest[1]), extra: {v: 1},
            };
        }
        case TOPIC.UndelegateV2: {
            // (address indexed delegator, address indexed withdrawal, uint shares, uint amount)
            const delegator = topicAddr(t[1]);
            const withdrawal = topicAddr(t[2]);
            if (t.length !== 3 || !delegator || !withdrawal || w.length < 2) bad(log, 'Undelegate V2');
            return {
                eventType: StakingEventType.Undelegate, validator: emitter, account: delegator,
                counterparty: withdrawal, shares: wordUint(w[0]), amount: wordUint(w[1]),
            };
        }
        case TOPIC.OwnershipTransferred: {
            const prev = topicAddr(t[1]);
            const next = topicAddr(t[2]);
            if (t.length !== 3 || !prev || !next) bad(log, 'OwnershipTransferred');
            return {eventType: StakingEventType.OwnershipTransferred, validator: emitter, account: prev, counterparty: next};
        }
        case TOPIC.CommissionRateChanged:
        case TOPIC.WithdrawalFeeInGweiChanged: {
            if (t.length !== 1 || w.length < 2) bad(log, 'parameter change');
            const eventType = t[0] === TOPIC.CommissionRateChanged
                ? StakingEventType.CommissionRateChanged : StakingEventType.WithdrawalFeeInGweiChanged;
            return {eventType, validator: emitter, extra: {old: wordUint(w[0]), new: wordUint(w[1])}};
        }
        case TOPIC.WithdrawCommission:
        case TOPIC.WithdrawTipFee: {
            const owner = topicAddr(t[1]);
            const withdrawal = topicAddr(t[2]);
            if (t.length !== 3 || !owner || !withdrawal || w.length < 1) bad(log, 'withdraw');
            const eventType = t[0] === TOPIC.WithdrawCommission
                ? StakingEventType.WithdrawCommission : StakingEventType.WithdrawTipFee;
            return {eventType, validator: emitter, account: owner, counterparty: withdrawal, amount: wordUint(w[0])};
        }
        case TOPIC.Exited: {
            const owner = topicAddr(t[1]);
            if (t.length !== 2 || !owner) bad(log, 'Exited');
            return {eventType: StakingEventType.Exited, validator: emitter, account: owner};
        }
    }
    return null;
}

/**
 * Validators registered through genesis deposits rather than
 * `createValidator`, so no ValidatorCreated/ValidatorInitialized exists for
 * them. Addresses match the deposits in each network's genesis.json (address =
 * last 20 bytes of the 0x01 credentials, 500 0G each).
 *
 * mainnet: operator and shares checked at block 1 -- the owner 0x711b...2522
 * holds all 500e18 shares of each.
 *
 * testnet: each pool also holds 500e18 shares at block 1, but not in the
 * owner's name, and later events show other addresses undelegating far more
 * than they ever delegated: testnet state predates its event history. So only
 * the addresses are seeded, which keeps their events from being filtered out;
 * shares are left to the refresher's reconciliation.
 */
export interface GenesisValidator {
    address: string
    operator: string
    /**
     * operator's initial shares, wei (the pool starts empty, so shares == amount);
     * null when unknown, and then no shares are seeded
     */
    amount: string | null
}

export const GENESIS_VALIDATORS: {[network: string]: GenesisValidator[]} = {
    mainnet: [
        '0x712a30816a8756c8fdb78de63db55aa70d3cf3b4',
        '0x81568b27b210538869f5659035ebf506d2fc3384',
        '0x8ee1af5b2791c7fa6065a02e4b579a9cc78388fb',
        '0xcb8fb96dd0f60085c9b0ef4ffaea219caffbf972',
    ].map(address => ({
        address,
        operator: '0x711b0ecb072c27de0e50c9944d7195a51b202522',
        amount: '500000000000000000000',
    })),
    testnet: [
        '0x08fc637a7802c1210cc071c2dc65bcad26badbdf',
        '0xcc6e4f0a7fc8754c247a4cc7c189d94e3c844213',
        '0xa96d3f1228115a3945045d5aa18c5b7a9f4d943e',
        '0x8936421339b144259187e7ecbe185771bfc1bbd4',
    ].map(address => ({
        address,
        operator: '0x565e66aa2bcb27116937983f2f208efabf620ab2',
        amount: null,
    })),
    none: [],
};
