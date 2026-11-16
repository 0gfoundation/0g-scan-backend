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
    /** not stored any more: fetched only to tell exit implementations apart; rows from before stay */
    Exited = 25,
    /**
     * The validator beacon's Upgraded(implementation): every validator proxy
     * runs the new implementation from this block on. `validator` holds the
     * beacon address, `account` the implementation, and `extra` what the
     * implementation's bytecode shows: {emitsExited, selfDelegation}.
     * Internal: it drives the commission model and is not served by /events.
     */
    ImplementationUpgraded = 30,
    /**
     * Synthetic, written by the refresher: the operator's on-chain shares
     * dropped without an event we can see. Slashing is a system call whose logs
     * `eth_getLogs` does not return, so this is the only trace it leaves.
     * `blockNumber` is the block the discrepancy was observed at, `logIndex` -1.
     * Internal: it keeps shares right and is never served by the API.
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
    /** tipFee(): what withdrawTipFee would pay out now */
    tipFee?: string
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
    tipFee?: string;
    stakes?: string;
    apy?: string;
    bondStatus?: number;
    minSelfDelegationInGwei?: string;
    beaconStatus?: string;
    beaconEffectiveBalance?: string;
    refreshedBlock?: number;
    refreshedAt?: Date;

    static register(seq: Sequelize) {
        // a fresh object per attribute: Sequelize writes the column name into the
        // definition it is given, so one shared object maps every attribute onto
        // the same column
        const amount = () => ({type: DataTypes.DECIMAL(65, 0), allowNull: false, defaultValue: 0});
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
            withdrawalFeeInGwei: amount(),
            tokens: amount(),
            rewards: amount(),
            delegatorShares: amount(),
            commission: amount(),
            tipFee: amount(),
            stakes: amount(),
            apy: amount(),
            bondStatus: {type: DataTypes.TINYINT, allowNull: false, defaultValue: 0},
            minSelfDelegationInGwei: amount(),

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

/*
 * Per-block rewards and slashes, from each block's withdrawals[0..2] and its
 * slashed array (see PLAN.md "区块奖励、佣金、社区税、基金会奖励与罚没"). Fed by
 * StakingBlockSync. Amounts are wei (the block carries gwei).
 */

export interface IStakingBlockReward {
    blockNumber: number
    createdAt: Date
    /** withdrawals[0].address: the proposing validator's contract */
    validator: string
    /** withdrawals[0].amount */
    reward: string
    /** reward * communityTaxRate / 1e6, sent to the Staking contract's communityPoolAddress */
    communityTax: string
    /** reward * commissionRate / 1e6 while the owner meets minSelfDelegation, else 0 */
    commission: string
    /** withdrawals[1]: the recipient varies by block, so it is kept */
    restakingAddress: string
    restakingReward: string
    /**
     * withdrawals[2].amount. Its recipient is always the configured foundation
     * address, so it is not stored per block; any other recipient is recorded
     * in KV STAKING_FOUNDATION_OTHER_ADDRESSES and reported.
     */
    foundationReward: string
}

export class StakingBlockReward extends Model<IStakingBlockReward> implements IStakingBlockReward {
    blockNumber: number;
    createdAt: Date;
    validator: string;
    reward: string;
    communityTax: string;
    commission: string;
    restakingAddress: string;
    restakingReward: string;
    foundationReward: string;

    static register(seq: Sequelize) {
        const amount = () => ({type: DataTypes.DECIMAL(65, 0), allowNull: false, defaultValue: 0});
        StakingBlockReward.init({
            blockNumber: {type: DataTypes.BIGINT, allowNull: false, primaryKey: true},
            createdAt: {type: DataTypes.DATE, allowNull: false},
            validator: {type: DataTypes.STRING(42), allowNull: false},
            reward: amount(),
            communityTax: amount(),
            commission: amount(),
            restakingAddress: {type: DataTypes.STRING(42), allowNull: false, defaultValue: ''},
            restakingReward: amount(),
            foundationReward: amount(),
        }, {
            sequelize: seq,
            tableName: 'staking_block_reward',
            timestamps: false,
            indexes: [
                {name: 'idx_time', fields: ['createdAt']},
                {name: 'idx_validator_time', fields: ['validator', 'createdAt']},
            ],
        })
    }
}

export interface IStakingBlockSlash {
    id?: number
    blockNumber: number
    createdAt: Date
    /** position in the block's slashed array */
    position: number
    /** slashed[i].index: evidence height (CometBFT misbehavior height / slashingInfo slot) */
    slashIndex: string
    /** slashed[i].validatorIndex: consensus-layer validator index */
    validatorIndex: string
    /** slashed[i].address: execution withdrawal address, i.e. the validator contract */
    validator: string
    amount: string
}

export class StakingBlockSlash extends Model<IStakingBlockSlash> implements IStakingBlockSlash {
    id?: number;
    blockNumber: number;
    createdAt: Date;
    position: number;
    slashIndex: string;
    validatorIndex: string;
    validator: string;
    amount: string;

    static register(seq: Sequelize) {
        StakingBlockSlash.init({
            id: {type: DataTypes.BIGINT, allowNull: false, autoIncrement: true, primaryKey: true},
            blockNumber: {type: DataTypes.BIGINT, allowNull: false},
            createdAt: {type: DataTypes.DATE, allowNull: false},
            position: {type: DataTypes.INTEGER, allowNull: false},
            slashIndex: {type: DataTypes.STRING(20), allowNull: false},
            validatorIndex: {type: DataTypes.STRING(20), allowNull: false},
            validator: {type: DataTypes.STRING(42), allowNull: false},
            amount: {type: DataTypes.DECIMAL(65, 0), allowNull: false},
        }, {
            sequelize: seq,
            tableName: 'staking_block_slash',
            timestamps: false,
            indexes: [
                {name: 'uk_block_position', fields: ['blockNumber', 'position'], unique: true},
                {name: 'idx_validator_time', fields: ['validator', 'createdAt']},
                {name: 'idx_time', fields: ['createdAt']},
            ],
        })
    }
}

export interface IStakingRewardDaily {
    id?: number
    /** UTC day, YYYY-MM-DD */
    day: string
    validator: string
    blockCount: number
    reward: string
    communityTax: string
    commission: string
    restakingReward: string
    foundationReward: string
    slashCount: number
    slashedAmount: string
}

/**
 * Per (UTC day, validator) totals, added to in the same transaction as the
 * per-block rows. Rewards, tax, commission and foundation rewards belong to
 * the block's proposer; slashes to the slashed validator.
 */
export class StakingRewardDaily extends Model<IStakingRewardDaily> implements IStakingRewardDaily {
    id?: number;
    day: string;
    validator: string;
    blockCount: number;
    reward: string;
    communityTax: string;
    commission: string;
    restakingReward: string;
    foundationReward: string;
    slashCount: number;
    slashedAmount: string;

    static register(seq: Sequelize) {
        const amount = () => ({type: DataTypes.DECIMAL(65, 0), allowNull: false, defaultValue: 0});
        StakingRewardDaily.init({
            id: {type: DataTypes.BIGINT, allowNull: false, autoIncrement: true, primaryKey: true},
            day: {type: DataTypes.DATEONLY, allowNull: false},
            validator: {type: DataTypes.STRING(42), allowNull: false},
            blockCount: {type: DataTypes.INTEGER({unsigned: true}), allowNull: false, defaultValue: 0},
            reward: amount(),
            communityTax: amount(),
            commission: amount(),
            restakingReward: amount(),
            foundationReward: amount(),
            slashCount: {type: DataTypes.INTEGER({unsigned: true}), allowNull: false, defaultValue: 0},
            slashedAmount: amount(),
        }, {
            sequelize: seq,
            tableName: 'staking_reward_daily',
            timestamps: false,
            indexes: [
                {name: 'uk_day_validator', fields: ['day', 'validator'], unique: true},
                {name: 'idx_validator_day', fields: ['validator', 'day']},
            ],
        })
    }
}

export interface IStakingSelfDelegation {
    id?: number
    validator: string
    /**
     * first block whose reward this applies to. A block's reward is
     * distributed after its transactions and before its slashes, so a
     * transaction in block b (a delegation, an ownership transfer, an upgrade)
     * applies from b, and a slash in block b from b + 1.
     */
    fromBlock: number
    /** the block whose post-state was read (or approximated) */
    stateBlock?: number
    owner: string
    ok: boolean
    /** `state_read`: getDelegatedTokens(owner) vs minSelfDelegation at fromBlock; `approx`: from indexed shares at the current share price, when the RPC has no state for that block */
    source: string
}

/**
 * Whether a validator's owner met minSelfDelegation, the condition under
 * which _distributeRewards accrues commission. Evaluated at the blocks where
 * it can flip (collection start, owner Delegate/Undelegate,
 * OwnershipTransferred, SlashDetected) and cached here.
 */
export class StakingSelfDelegation extends Model<IStakingSelfDelegation> implements IStakingSelfDelegation {
    id?: number;
    validator: string;
    fromBlock: number;
    stateBlock?: number;
    owner: string;
    ok: boolean;
    source: string;

    static register(seq: Sequelize) {
        StakingSelfDelegation.init({
            id: {type: DataTypes.BIGINT, allowNull: false, autoIncrement: true, primaryKey: true},
            validator: {type: DataTypes.STRING(42), allowNull: false},
            fromBlock: {type: DataTypes.BIGINT, allowNull: false},
            stateBlock: {type: DataTypes.BIGINT, allowNull: true},
            owner: {type: DataTypes.STRING(42), allowNull: false},
            ok: {type: DataTypes.BOOLEAN, allowNull: false},
            source: {type: DataTypes.STRING(16), allowNull: false},
        }, {
            sequelize: seq,
            tableName: 'staking_self_delegation',
            timestamps: false,
            indexes: [
                {name: 'uk_validator_block', fields: ['validator', 'fromBlock'], unique: true},
            ],
        })
    }
}

export interface IStakingCommissionCheck {
    id?: number
    /** checkpoint: the block-reward cursor when commission() was read */
    blockNumber: number
    createdAt: Date
    validator: string
    /** commission() at blockNumber */
    commission: string
    /** previous checkpoint for this validator; null for a baseline */
    prevBlock: number | null
    /** sum of the collected per-block commission over (prevBlock, blockNumber] */
    expected: string | null
    /** commission() delta + WithdrawCommission - exit settlement over the same blocks */
    actual: string | null
    /** baseline | ok | mismatch | unknown (an exit settlement in the window is unknown) */
    status: string
}

/**
 * Commission reconciliation checkpoints (StakingCheck): what the chain
 * accrued against what the block sync computed, per validator and window.
 */
export class StakingCommissionCheck extends Model<IStakingCommissionCheck> implements IStakingCommissionCheck {
    id?: number;
    blockNumber: number;
    createdAt: Date;
    validator: string;
    commission: string;
    prevBlock: number | null;
    expected: string | null;
    actual: string | null;
    status: string;

    static register(seq: Sequelize) {
        const amount = (allowNull: boolean) => ({type: DataTypes.DECIMAL(65, 0), allowNull});
        StakingCommissionCheck.init({
            id: {type: DataTypes.BIGINT, allowNull: false, autoIncrement: true, primaryKey: true},
            blockNumber: {type: DataTypes.BIGINT, allowNull: false},
            createdAt: {type: DataTypes.DATE, allowNull: false},
            validator: {type: DataTypes.STRING(42), allowNull: false},
            commission: amount(false),
            prevBlock: {type: DataTypes.BIGINT, allowNull: true},
            expected: amount(true),
            actual: amount(true),
            status: {type: DataTypes.STRING(16), allowNull: false},
        }, {
            sequelize: seq,
            tableName: 'staking_commission_check',
            timestamps: false,
            indexes: [
                {name: 'uk_block_validator', fields: ['blockNumber', 'validator'], unique: true},
                {name: 'idx_validator_block', fields: ['validator', 'blockNumber']},
                {name: 'idx_status', fields: ['status']},
            ],
        })
    }
}
