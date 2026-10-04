export interface Withdrawal {
	index: string;
	validatorIndex: string;
	address: string;
	amount: string;
}

export interface WithdrawalParsed {
	index: number;
	validatorIndex: number;
	address: string;
	amount: number;
}

export interface WithdrawalsData {
	withdrawals: Withdrawal[];
	withdrawalsRoot: string;
	number: string;
}

export interface WithdrawalsDataParsed {
	withdrawals: WithdrawalParsed[];
	withdrawalsRoot: string;
	totalAmount: number;
	blockNumber: number;
}


export class WithdrawalParser {
	/**
	 * Parse hex string to number
	 * Handles large numbers that might exceed JavaScript's safe integer limit
	 */
	static parseHexToNumber(hexValue: string): number {
		if (!hexValue.startsWith('0x')) {
			throw new Error(`Invalid hex value: ${hexValue}`);
		}

		// Remove '0x' prefix and parse
		const hexString = hexValue.slice(2);

		// For very large numbers, use BigInt and convert to number if safe
		const bigIntValue = BigInt(hexValue);

		if (bigIntValue <= BigInt(Number.MAX_SAFE_INTEGER)) {
			return Number(bigIntValue);
		} else {
			// For numbers larger than safe integer, you might want to handle differently
			// For now, we'll return as number but this might lose precision
			return Number(bigIntValue);
		}
	}

	/**
	 * Parse a single withdrawal object
	 */
	static parseWithdrawal(withdrawal: Withdrawal): WithdrawalParsed {
		return {
			index: WithdrawalParser.parseHexToNumber(withdrawal.index),
			validatorIndex: WithdrawalParser.parseHexToNumber(withdrawal.validatorIndex),
			address: withdrawal.address,
			amount: WithdrawalParser.parseHexToNumber(withdrawal.amount)
		};
	}

	/**
	 * Parse withdrawals data and calculate total amount
	 */
	static parseWithdrawalsData(data: WithdrawalsData): WithdrawalsDataParsed {
		const parsedWithdrawals = data.withdrawals.map(WithdrawalParser.parseWithdrawal);

		const totalAmount = parsedWithdrawals.reduce((sum, withdrawal) => {
			return sum + withdrawal.amount;
		}, 0);

		return {
			withdrawals: parsedWithdrawals,
			withdrawalsRoot: data.withdrawalsRoot,
			totalAmount, blockNumber: WithdrawalParser.parseHexToNumber(data.number)
		};
	}

	/**
	 * Sum amounts from parsed withdrawals
	 */
	static sumAmounts(withdrawals: WithdrawalParsed[]): number {
		return withdrawals.reduce((sum, withdrawal) => sum + withdrawal.amount, 0);
	}

	/**
	 * Sum amounts directly from raw withdrawals data
	 */
	static sumAmountsRaw(withdrawals: Withdrawal[]): number {
		return withdrawals.reduce((sum, withdrawal) => {
			return sum + WithdrawalParser.parseHexToNumber(withdrawal.amount);
		}, 0);
	}
}

import { DataTypes, Model, Optional, Sequelize } from 'sequelize';

// Define interfaces for Sequelize
interface WithdrawalAttributes {
	id?: number;
	blockNo: number;
	wIndex: number;
	validatorIndex: number;
	address: string;
	amount: number;
	withdrawalsRoot: string;
	createdAt?: Date;
	updatedAt?: Date;
}

export interface WithdrawalCreationAttributes extends Optional<WithdrawalAttributes, 'id'> {}

export class WithdrawalModel extends Model<WithdrawalAttributes, WithdrawalCreationAttributes>
	implements WithdrawalAttributes {

	public id!: number;
	public blockNo: number;
	public wIndex!: number;
	public validatorIndex!: number;
	public address!: string;
	public amount!: number;
	public withdrawalsRoot!: string;
	public readonly createdAt!: Date;
	public readonly updatedAt!: Date;
}

export const initWithdrawalModel = (sequelize: Sequelize): typeof WithdrawalModel => {
	WithdrawalModel.init(
		{
			id: {
				type: DataTypes.INTEGER,
				autoIncrement: true,
				primaryKey: true,
			},
			blockNo: {
				type: DataTypes.BIGINT,
				allowNull: false, unique: true,
			},
			wIndex: {
				type: DataTypes.BIGINT,
				allowNull: false,
			},
			validatorIndex: {
				type: DataTypes.BIGINT,
				allowNull: false,
			},
			address: {
				type: DataTypes.STRING(42), // Ethereum address length
				allowNull: false,
				validate: {
					is: /^0x[a-fA-F0-9]{40}$/ // Basic Ethereum address validation
				}
			},
			amount: {
				type: DataTypes.BIGINT,
				allowNull: false,
			},
			withdrawalsRoot: {
				type: DataTypes.STRING(66), // SHA-256 hash length
				allowNull: false,
			}
		},
		{
			sequelize,
			tableName: 'withdrawals',
			indexes: [
				{
					name: 'idx_block',
					fields: ['blockNo'],
				},
			]
		}
	);

	return WithdrawalModel;
};

// Utility function to create withdrawal records
export const createWithdrawalRecords = async (
	sequelize: Sequelize,
	data: WithdrawalsData
): Promise<WithdrawalModel[]> => {
	const Withdrawal = initWithdrawalModel(sequelize);

	const parsedData = WithdrawalParser.parseWithdrawalsData(data);

	const withdrawalRecords = await Withdrawal.bulkCreate(
		parsedData.withdrawals.map(withdrawal => ({
			...withdrawal,
			withdrawalsRoot: parsedData.withdrawalsRoot
		})),
		{ ignoreDuplicates: true }
	);

	return withdrawalRecords;
};

// A withdrawal the consensus layer emits for itself rather than for a validator exit
// carries uint64 max in both index fields.
export const WITHDRAWAL_SENTINEL_INDEX = 18446744073709551615;

export interface BlockRewards {
	nativeReward: number;
	restakingReward: number;
	baseInflation: number;
	blockReward: number;
	/** Withdrawals that pay a validator exit -- principal coming back, not new supply. */
	unstakes: WithdrawalParsed[];
}

/**
 * Split a block's withdrawals into newly issued supply and returning stake.
 *
 * The first three entries are the reward triple -- native reward, restaking reward, base
 * inflation, in that order -- and they are newly minted, so their sum is what the chain
 * issued in this block. Anything else is a validator exit paying principal back to the
 * execution layer, which is not new supply.
 *
 * Both the position and the sentinel index have to agree before an entry counts as a
 * reward: position alone would miscount a block that somehow emits fewer than three, and
 * the sentinel alone would not say which of the three a given entry is.
 */
export function splitBlockRewards(withdrawals: WithdrawalParsed[]): BlockRewards {
	const isReward = (w: WithdrawalParsed, position: number) =>
		position < 3 && w.validatorIndex === WITHDRAWAL_SENTINEL_INDEX;
	const amountAt = (position: number) =>
		withdrawals[position] && isReward(withdrawals[position], position) ? withdrawals[position].amount : 0;

	const nativeReward = amountAt(0);
	const restakingReward = amountAt(1);
	const baseInflation = amountAt(2);
	return {
		nativeReward,
		restakingReward,
		baseInflation,
		blockReward: nativeReward + restakingReward + baseInflation,
		unstakes: withdrawals.filter((w, position) => !isReward(w, position)),
	};
}

export class WithdrawalUtils {
	/**
	 * Filter out zero-amount withdrawals
	 */
	static filterNonZeroWithdrawals(withdrawals: WithdrawalParsed[]): WithdrawalParsed[] {
		return withdrawals.filter(withdrawal => withdrawal.amount > 0);
	}

	/**
	 * Group withdrawals by address
	 */
	static groupByAddress(withdrawals: WithdrawalParsed[]): Map<string, WithdrawalParsed[]> {
		const grouped = new Map<string, WithdrawalParsed[]>();

		withdrawals.forEach(withdrawal => {
			if (!grouped.has(withdrawal.address)) {
				grouped.set(withdrawal.address, []);
			}
			grouped.get(withdrawal.address)!.push(withdrawal);
		});

		return grouped;
	}

	/**
	 * Get total amount by address
	 */
	static getTotalByAddress(withdrawals: WithdrawalParsed[]): Map<string, number> {
		const grouped = WithdrawalUtils.groupByAddress(withdrawals);
		const totals = new Map<string, number>();

		grouped.forEach((withdrawals, address) => {
			const total = withdrawals.reduce((sum, w) => sum + w.amount, 0);
			totals.set(address, total);
		});

		return totals;
	}
}

// BlockWithdraw Model Interfaces
interface BlockWithdrawAttributes {
	id?: number;
	blockNumber: number;
	sumAmount: number; // Current block's total withdrawal amount
	cumulativeAmount: string; // Cumulative amount across blocks
	withdrawalsRoot: string;
	// The reward triple of this block, and the running total of their sum. `sumAmount`
	// mixes these with validator exits, so only `cumulativeReward` measures issuance.
	nativeReward?: number;
	restakingReward?: number;
	baseInflation?: number;
	cumulativeReward?: string;
	createdAt?: Date;
	updatedAt?: Date;
}

export interface BlockWithdrawCreationAttributes extends Optional<BlockWithdrawAttributes, 'id'> {}

export class BlockWithdrawModel extends Model<BlockWithdrawAttributes, BlockWithdrawCreationAttributes>
	implements BlockWithdrawAttributes {

	public id!: number;
	public blockNumber!: number;
	public sumAmount!: number;
	public cumulativeAmount!: string;
	public withdrawalsRoot!: string;
	public nativeReward: number;
	public restakingReward: number;
	public baseInflation: number;
	public cumulativeReward: string;
	public readonly createdAt!: Date;
	public readonly updatedAt!: Date;
}

export const initBlockWithdrawModel = (sequelize: Sequelize): typeof BlockWithdrawModel => {
	BlockWithdrawModel.init(
		{
			id: {
				type: DataTypes.INTEGER,
				autoIncrement: true,
				primaryKey: true,
			},
			blockNumber: {
				type: DataTypes.BIGINT,
				allowNull: false,
				unique: true, // Each block should have only one record
				comment: 'Block number'
			},
			sumAmount: {
				type: DataTypes.BIGINT, // 36 total digits, 18 decimal places
				allowNull: false,
				comment: 'Total withdrawal amount in this block'
			},
			cumulativeAmount: {
				type: DataTypes.DECIMAL(36, 18), // 36 total digits, 18 decimal places
				allowNull: false,
				comment: 'Cumulative withdrawal amount up to this block'
			},
			nativeReward: {
				type: DataTypes.BIGINT,
				allowNull: true,
				comment: 'withdrawals[0]: native staking reward minted in this block'
			},
			restakingReward: {
				type: DataTypes.BIGINT,
				allowNull: true,
				comment: 'withdrawals[1]: restaking reward minted in this block'
			},
			baseInflation: {
				type: DataTypes.BIGINT,
				allowNull: true,
				comment: 'withdrawals[2]: base inflation minted in this block'
			},
			cumulativeReward: {
				type: DataTypes.DECIMAL(36, 18),
				allowNull: true,
				comment: 'Cumulative block reward up to this block -- issuance, excluding validator exits'
			},
			withdrawalsRoot: {
				type: DataTypes.STRING(66), // SHA-256 hash length
				allowNull: false,
				comment: 'Merkle root of withdrawals in this block'
			}
		},
		{
			sequelize,
			tableName: 'block_withdraws',
			indexes: [
				{
					name: 'idx_block',
					fields: ['blockNumber'],
					unique: true
				}
			]
		}
	);

	return BlockWithdrawModel;
};

export async function getLatestBlockWithdraw(): Promise<BlockWithdrawModel | null> {
	return await BlockWithdrawModel.findOne({
		order: [['blockNumber', 'DESC']],
		raw: true,
	});
}


// validator RPC returns these data:
export interface ValidatorResponse {
	execution_optimistic: boolean;
	finalized: boolean;
	data: ValidatorData[];
}

export interface ValidatorData {
	index: string;
	balance: string;
	symbiotic_balance: string | null;
	status: string;
	validator: Validator;
}

export interface Validator {
	pubkey: string;
	withdrawal_credentials: string;
	effective_balance: string; // This is the field we need to sum
	slashed: boolean;
	activation_eligibility_epoch: string;
	activation_epoch: string;
	exit_epoch: string;
	withdrawable_epoch: string;
}

// Sum effective balance as BigInt (recommended for large numbers)
export function sumEffectiveBalanceBigInt(response: ValidatorResponse): bigint {
	let total = 0n;

	for (const data of response.data) {
		const balance = BigInt(data.validator.effective_balance);
		total += balance;
	}

	return total;
}
