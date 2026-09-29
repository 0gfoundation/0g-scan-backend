import {DataTypes, Model, Sequelize} from "sequelize";

/**
 * 0G validator / delegation index, fed by `stat/service/staking/StakingSync`.
 * Contracts live in `common/contracts/gravity`; design notes in
 * `document/staking/PLAN.md`.
 *
 * Addresses are lowercase 0x hex. Amounts and shares are wei / raw uint as
 * DECIMAL(65,0), served as integer strings -- parse with BigInt, never Number().
 */

/** Values of `staking_event.eventType`. Stored as TINYINT, never renumber. */
export enum StakingEventType {
    ValidatorCreated = 1,
    ValidatorInitialized = 2,
    ValidatorExited = 3,
    Delegate = 10,
    Undelegate = 11,
    OwnershipTransferred = 20,
    CommissionRateChanged = 21,
    WithdrawalFeeInGweiChanged = 22,
    WithdrawCommission = 23,
    WithdrawTipFee = 24,
    Exited = 25,
    /**
     * Synthetic, written by the refresher: the operator's on-chain shares
     * dropped without an event we can see. Slashing is a system call whose logs
     * `eth_getLogs` does not return, so this is the only trace it leaves.
     * `blockNumber` is the block the discrepancy was observed at, `logIndex` -1.
     */
    SlashDetected = 90,
}

export interface IStakingValidator {
    address: string
    pubkey?: string
    isGenesis: boolean
    createdBlock?: number
    createdAt?: Date
    initializedBlock?: number
    exitedBlock?: number

    owner?: string
    operator?: string
    moniker?: string
    identity?: string
    website?: string
    securityContact?: string
    details?: string
    /** raw, 1_000_000 = 100% */
    commissionRate?: number
    withdrawalFeeInGwei?: string
    tokens?: string
    rewards?: string
    delegatorShares?: string
    commission?: string
    stakes?: string
    /** raw `annualPercentageYield()`, 10_000 = 100% */
    apy?: string
    /** IValidatorContract.BondStatus: 0 Unspecified, 1 Unbonded, 2 Unbonding, 3 Bonded */
    bondStatus?: number
    minSelfDelegationInGwei?: string

    /** raw beacon status, e.g. `active_ongoing`; null when the beacon API has no entry */
    beaconStatus?: string
    /** gwei */
    beaconEffectiveBalance?: string

    refreshedBlock?: number
    refreshedAt?: Date
}

export class StakingValidator extends Model<IStakingValidator> implements IStakingValidator {
    address: string;
    pubkey?: string;
    isGenesis: boolean;
    createdBlock?: number;
    createdAt?: Date;
    initializedBlock?: number;
    exitedBlock?: number;
    owner?: string;
    operator?: string;
    moniker?: string;
    identity?: string;
    website?: string;
    securityContact?: string;
    details?: string;
    commissionRate?: number;
    withdrawalFeeInGwei?: string;
    tokens?: string;
    rewards?: string;
    delegatorShares?: string;
    commission?: string;
    stakes?: string;
    apy?: string;
    bondStatus?: number;
    minSelfDelegationInGwei?: string;
    beaconStatus?: string;
    beaconEffectiveBalance?: string;
    refreshedBlock?: number;
    refreshedAt?: Date;

    static register(seq: Sequelize) {
        const amount = {type: DataTypes.DECIMAL(65, 0), allowNull: false, defaultValue: 0};
        StakingValidator.init({
            address: {type: DataTypes.STRING(42), allowNull: false, primaryKey: true},
            // raw 48-byte BLS key; genesis validators get it from the refresher
            pubkey: {type: DataTypes.STRING(98), allowNull: true},
            isGenesis: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
            createdBlock: {type: DataTypes.BIGINT, allowNull: true},
            // block time of creation, not row insertion
            createdAt: {type: DataTypes.DATE, allowNull: true},
            initializedBlock: {type: DataTypes.BIGINT, allowNull: true},
            exitedBlock: {type: DataTypes.BIGINT, allowNull: true},

            owner: {type: DataTypes.STRING(42), allowNull: true},
            operator: {type: DataTypes.STRING(42), allowNull: true},
            // max lengths enforced by StakingContract.initializeValidator
            moniker: {type: DataTypes.STRING(70), allowNull: false, defaultValue: ''},
            identity: {type: DataTypes.STRING(3000), allowNull: false, defaultValue: ''},
            website: {type: DataTypes.STRING(140), allowNull: false, defaultValue: ''},
            securityContact: {type: DataTypes.STRING(140), allowNull: false, defaultValue: ''},
            details: {type: DataTypes.STRING(280), allowNull: false, defaultValue: ''},
            commissionRate: {type: DataTypes.INTEGER({unsigned: true}), allowNull: false, defaultValue: 0},
            withdrawalFeeInGwei: amount,
            tokens: amount,
            rewards: amount,
            delegatorShares: amount,
            commission: amount,
            stakes: amount,
            apy: amount,
            bondStatus: {type: DataTypes.TINYINT, allowNull: false, defaultValue: 0},
            minSelfDelegationInGwei: amount,

            beaconStatus: {type: DataTypes.STRING(32), allowNull: true},
            beaconEffectiveBalance: {type: DataTypes.DECIMAL(65, 0), allowNull: true},

            refreshedBlock: {type: DataTypes.BIGINT, allowNull: true},
            refreshedAt: {type: DataTypes.DATE, allowNull: true},
        }, {
            sequelize: seq,
            tableName: 'staking_validator',
            timestamps: false,
        })
    }
}

export interface IStakingDelegation {
    id?: number
    validator: string
    delegator: string
    shares: string
    firstBlock: number
    lastBlock: number
    firstAt?: Date
    lastAt?: Date
}

/**
 * Current shares per (validator, delegator), maintained by adding up events:
 * ValidatorInitialized credits the operator, Delegate adds, Undelegate
 * subtracts. Slashing has no visible event, so the refresher corrects the
 * operator's row from chain state. Rows reaching 0 are kept.
 *
 * Token value is not stored: it moves every block as rewards accrue, so it is
 * computed at query time as `shares * (tokens + rewards) / delegatorShares`
 * from the validator row, matching `getDelegatedTokens`.
 */
export class StakingDelegation extends Model<IStakingDelegation> implements IStakingDelegation {
    id?: number;
    validator: string;
    delegator: string;
    shares: string;
    firstBlock: number;
    lastBlock: number;
    firstAt?: Date;
    lastAt?: Date;

    static register(seq: Sequelize) {
        StakingDelegation.init({
            id: {type: DataTypes.BIGINT, allowNull: false, autoIncrement: true, primaryKey: true},
            validator: {type: DataTypes.STRING(42), allowNull: false},
            delegator: {type: DataTypes.STRING(42), allowNull: false},
            // signed on purpose: a negative value is a detectable bug, not an overflow
            shares: {type: DataTypes.DECIMAL(65, 0), allowNull: false, defaultValue: 0},
            firstBlock: {type: DataTypes.BIGINT, allowNull: false},
            lastBlock: {type: DataTypes.BIGINT, allowNull: false},
            firstAt: {type: DataTypes.DATE, allowNull: true},
            lastAt: {type: DataTypes.DATE, allowNull: true},
        }, {
            sequelize: seq,
            tableName: 'staking_delegation',
            timestamps: false,
            indexes: [
                {name: 'uk_validator_delegator', fields: ['validator', 'delegator'], unique: true},
                {name: 'idx_delegator', fields: ['delegator']},
                {name: 'idx_validator_shares', fields: ['validator', 'shares']},
            ]
        })
    }
}

export interface IStakingEvent {
    id?: number
    blockNumber: number
    blockHash: string
    createdAt: Date
    txHash: string
    txIndex: number
    logIndex: number
    validator: string
    eventType: StakingEventType
    /** delegator for Delegate/Undelegate, owner/operator otherwise */
    account?: string
    /** payer (Delegate V2), withdrawal address, or new owner */
    counterparty?: string
    amount?: string
    shares?: string
    extra?: object
}

export class StakingEvent extends Model<IStakingEvent> implements IStakingEvent {
    id?: number;
    blockNumber: number;
    blockHash: string;
    createdAt: Date;
    txHash: string;
    txIndex: number;
    logIndex: number;
    validator: string;
    eventType: StakingEventType;
    account?: string;
    counterparty?: string;
    amount?: string;
    shares?: string;
    extra?: object;

    static register(seq: Sequelize) {
        StakingEvent.init({
            id: {type: DataTypes.BIGINT, allowNull: false, autoIncrement: true, primaryKey: true},
            blockNumber: {type: DataTypes.BIGINT, allowNull: false},
            blockHash: {type: DataTypes.STRING(66), allowNull: false, defaultValue: ''},
            // block time
            createdAt: {type: DataTypes.DATE, allowNull: false},
            txHash: {type: DataTypes.STRING(66), allowNull: false, defaultValue: ''},
            txIndex: {type: DataTypes.INTEGER, allowNull: false, defaultValue: -1},
            logIndex: {type: DataTypes.INTEGER, allowNull: false},
            validator: {type: DataTypes.STRING(42), allowNull: false},
            eventType: {type: DataTypes.TINYINT({unsigned: true}), allowNull: false},
            account: {type: DataTypes.STRING(42), allowNull: true},
            counterparty: {type: DataTypes.STRING(42), allowNull: true},
            amount: {type: DataTypes.DECIMAL(65, 0), allowNull: true},
            shares: {type: DataTypes.DECIMAL(65, 0), allowNull: true},
            extra: {type: DataTypes.JSON, allowNull: true},
        }, {
            sequelize: seq,
            tableName: 'staking_event',
            timestamps: false,
            indexes: [
                // a real log is unique by (block, logIndex); validator is in the key
                // so synthetic rows (logIndex -1) can share an observation block
                {name: 'uk_block_log', fields: ['blockNumber', 'logIndex', 'validator'], unique: true},
                {name: 'idx_validator_type_time', fields: ['validator', 'eventType', 'createdAt']},
                {name: 'idx_account_type_time', fields: ['account', 'eventType', 'createdAt']},
                {name: 'idx_type_time', fields: ['eventType', 'createdAt']},
                {name: 'idx_tx', fields: ['txHash']},
            ]
        })
    }
}
