import {JsonRpcProvider} from "@ethersproject/providers/src.ts/json-rpc-provider";
import {getCfxSdk, initEthSdk} from "./common/utils";
import {
	BlockWithdrawCreationAttributes,
	BlockWithdrawModel,
	getLatestBlockWithdraw,
	initBlockWithdrawModel, sumValidatorBalanceBigInt, ValidatorResponse,
	WithdrawalCreationAttributes,
	WithdrawalParser,
	WithdrawalUtils
} from "../model/ZG";
import {init} from "./tool/FixDailyTokenStat";
import {KV} from "../model/KV";
import {Sequelize} from "sequelize";
import {regExitHook, sleep} from "./tool/ProcessTool";
import {formatEther, parseEther} from "ethers/lib/utils";
import {SupplyInfo} from "js-conflux-sdk/dist/types/rpc/types/formatter";
import {ConfigInstance, NoCoreSpace} from "../config/StatConfig";
import {Conflux} from "js-conflux-sdk";

const ctx = {
	preEntry: null as BlockWithdrawCreationAttributes,
	eth: undefined as JsonRpcProvider,
	cumulative: 0n,
}

async function getBlockWithdraws(p: JsonRpcProvider, blockNumber: number) {
	// raw rpc
	const rawBlock = await p.send('eth_getBlockByNumber', ['0x'+blockNumber.toString(16), false])
	if (!rawBlock) {
		return {message: `getting block returns null`};
	}
	const wd =  WithdrawalParser.parseWithdrawalsData(rawBlock)
	// console.log(`withdrawals data`, wd)

	const nonZeroWithdrawals = WithdrawalUtils.filterNonZeroWithdrawals(wd.withdrawals);
	// each withdraw
	const beans = nonZeroWithdrawals.map(w=>{
		return {
			id: 0, blockNo: wd.blockNumber,
			address: w.address, amount: w.amount,
			wIndex: w.index, validatorIndex: w.validatorIndex,
		} as WithdrawalCreationAttributes
	})
	return {
		withdrawData: wd, withdraws: beans
	}
}

async function setupPreBlock() {
	ctx.preEntry = await getLatestBlockWithdraw();
	if (!ctx.preEntry) {
		const firstBlk = await ctx.eth.getBlock("earliest");
		ctx.preEntry = {
			blockNumber: firstBlk.number - 1, sumAmount: 0, cumulativeAmount: '0',
			withdrawalsRoot: '',
		}
		// no record in DB,
		console.log(`first block number is `, firstBlk.number);
	} else {
		ctx.cumulative = parseEther(ctx.preEntry.cumulativeAmount).toBigInt()
	}
}

async function sync(seq?: Sequelize) {
	let useSeq = seq;
	if (!useSeq) {
		const cfg = await init();
		useSeq = KV.sequelize;
		regExitHook();
	}
	// initWithdrawalModel(useSeq);
	initBlockWithdrawModel(useSeq);
	await useSeq.sync({});

	await setupPreBlock();
	let round = 0;
	while (true) {
		const wantBlockNo = ctx.preEntry.blockNumber + 1;
		let failed = false
		const {withdrawData} = await getBlockWithdraws(ctx.eth, wantBlockNo).catch(e=>{
			console.log(`failed to get block withdraws at ${wantBlockNo}:`, e)
			failed = true;
			return {withdrawData: null}
		});
		if (failed || !withdrawData) {
			await sleep(5_000);
			continue;
		}
		const newBean = {
			blockNumber: withdrawData.blockNumber,
			sumAmount: withdrawData.totalAmount,
			withdrawalsRoot: withdrawData.withdrawalsRoot,
		} as BlockWithdrawCreationAttributes;
		// we have decimal in DB
		const drip = ctx.cumulative + BigInt(withdrawData.totalAmount);
		newBean.cumulativeAmount = formatEther(drip);

		await BlockWithdrawModel.create(newBean).then(()=>{
			ctx.preEntry = newBean;
			ctx.cumulative = drip;
		}).catch(async e=>{
			console.log(`failed to save block withdraw model:`, e)
			await sleep(5_000);
		});

		if ((round ++) % 1000 === 0) {
			console.log(`${new Date().toISOString()} reach block `, ctx.preEntry.blockNumber);
		}
	}
}

// The whole genesis allocation. The 2,000 0G staked at genesis is part of it wherever it
// now sits: which ledger holds a token does not change whether it exists, and the formula
// below no longer counts any ledger separately.
const ZGGenesisSupply = BigInt(parseEther('1000000000'));

export async function calculateEvmPosSupply(balanceOfZero: bigint): Promise<SupplyInfo & any> {
	const {total: blockWithdraw, rewards: blockReward, message: withdrawalMessage} = await sumWithdrawals();
	const sumContracts = await sumSpecialContractBalance(getCfxSdk()).catch(e=>{
		console.log(`failed to sum contract balance:`, e);
		return BigInt(0);
	})
	const {balance: totalStakes, message: validatorMessage} = await sumValidatorBalance();

	//     total       = genesis + everything minted since
	//     circulating = total - the contracts holding supply back
	//
	// Issuance is all that moves it, so nothing else has to be right for these to be
	// right. Staking does not: burning into 0x0 to mint on the consensus layer moves a
	// token between ledgers without creating or destroying one, which is why neither
	// `totalStakes` nor `balance(0x0)` appears. They used to, and the published figures
	// inherited every outage those two had -- a `validatorRpc` that stopped answering
	// took circulating down 73% in October while the chain itself was fine.
	const issued = ZGGenesisSupply + blockReward;
	const remain = issued - sumContracts.valueOf();

	// The ledger-by-ledger reading of the same total: start from what genesis put on the
	// execution layer, add what the consensus layer has paid out, take off what is burned
	// into 0x0, add what the consensus layer still holds. It shares only genesis with the
	// figure above, so the two drifting apart means one of these inputs has gone bad --
	// which is how summing `effective_balance` instead of `balance` was caught, at 1.24%.
	// Reported, not published: it is the check, not the answer.
	const fromLedgers = ZGGenesisSupply - BigInt(parseEther('2000'))
		+ blockWithdraw - balanceOfZero + totalStakes;

	return {
		sumContracts,
		sumBlockWithdrawal: blockWithdraw,
		sumBlockReward: blockReward,
		genesisSupply: ZGGenesisSupply,
		totalCirculating: remain,
		calculateEvmPosSupply: true,
		totalIssued: issued,
		totalIssuedFromLedgers: fromLedgers,
		totalStakes,
		validatorMessage,
		withdrawalMessage,
		// do not care fields below
		totalCollateral: undefined,
		totalEspaceTokens: undefined,
		totalStaking: undefined,
	};
}

// `fetch` reports every transport failure as the same flat "fetch failed"; the reason --
// ECONNREFUSED, ENOTFOUND, a certificate error -- is only on `cause`, so carry it through
// or these messages say nothing about what to go and fix.
function fetchFailure(e: any): string {
	return e?.cause ? `${e.message} (${e.cause.code || e.cause.message || e.cause})` : e?.message;
}

async function sumValidatorBalance(rpc?: string) {
	const ret = {balance: BigInt(0), message: ""};
	const rpcUsed = rpc || ConfigInstance.validatorRpc || ''
	if (!rpcUsed) {
		ret.message = "validator RPC is not set"
		return ret;
	}

	const data =  await fetch(rpcUsed).then(res=>res.json()).catch(e=>{
		console.log(`failed to fetch validator info:`, e)
		ret.message = `failed to fetch validator info: ` + fetchFailure(e);
		return null as ValidatorResponse;
	})
	if (!data) {
		return ret;
	}

	return {balance: sumValidatorBalanceBigInt(data) * BigInt(1e9), message: undefined };
}

/**
 * The consensus layer keeps its own running totals of what it has paid out to the
 * execution layer, on the same host as `validatorRpc`:
 *
 *     .../eth/v1/beacon/states/head/validators        <- validatorRpc, configured
 *     .../eth/v1/beacon/blocks/head/total_withdrawals <- derived from it
 *
 * `total` is every withdrawal ever credited and `rewards` is the issuance inside it --
 * the first three withdrawals of each block, which are minted rather than returning
 * stake. Set `withdrawalRpc` to override when the two do not sit under one host.
 */
export function withdrawalRpcUrl(): string {
	if (ConfigInstance.withdrawalRpc) {
		return ConfigInstance.withdrawalRpc;
	}
	const validatorRpc = ConfigInstance.validatorRpc || '';
	const derived = validatorRpc.replace(/\/states\/[^/]+\/validators\/?$/, '/blocks/head/total_withdrawals');
	// Unchanged means it did not look like the validators endpoint. Report nothing rather
	// than guess a URL and let the caller log why.
	return derived === validatorRpc ? '' : derived;
}

/**
 * Cumulative withdrawals and cumulative issuance, in drip.
 *
 * This used to come from `block_withdraws`, filled by this file's own `sync()` scanning
 * one block at a time. That has no compose service, so nothing restarted it after the
 * April 2026 migration and it silently froze at block ~30.9M: by October the stored total
 * was 311M against the chain's 462M, and the published supply was 150M light. The
 * consensus layer already keeps both totals, so read them instead of recomputing them.
 */
async function sumWithdrawals() {
	const ret = {total: BigInt(0), rewards: BigInt(0), message: ""};
	const url = withdrawalRpcUrl();
	if (!url) {
		ret.message = "withdrawal RPC is not set, and validatorRpc is not the validators endpoint";
		return ret;
	}

	const data = await fetch(url).then(res => res.json()).catch(e => {
		console.log(`failed to fetch withdrawal totals:`, e)
		ret.message = `failed to fetch withdrawal totals: ` + fetchFailure(e);
		return null as any;
	})
	if (!data?.data?.total) {
		ret.message = ret.message || `withdrawal totals missing from ${url}`;
		return ret;
	}

	// Gwei on the wire, like every other consensus layer figure here.
	return {
		total: BigInt(data.data.total) * BigInt(1e9),
		rewards: BigInt(data.data.rewards || 0) * BigInt(1e9),
		message: undefined,
	};
}

async function sumSpecialContractBalance(cfx:Conflux) {
	if (!cfx) {
		console.log(`cfx is not set`);
		return 0n;
	}
	const arr = [
		"0x739D87653757E834C8CD86407C1Bb2f86a787ecc",
		"0xF5321C5B04f6b702EBD3B8E06BEedA2655a5B8bF",
		"0xdd33275d285FD74A0F0Af369d9Ce335e3C5c5E1f",
		"0x9181b0A31Db3ce580A7cd5A91E115c7a484f2Bc0",
		"0xC16Bc66b220ad6155e43b7F847F6f77d29334717",
		"0x7C46a60e7C98CD1E5cFD98600e867886B3a0226c",
		"0x098DbaD8D4b8B7d8E665FB5f3433802693425419",
		"0xA50d10E7F898F01c3a3742cBF69CDDcFaCFd4438",
		"0xEF1605a64fDCcc84b36fb1c092B698DCF38fD502",
	];
	const bArr = await Promise.all(arr.map(addr=>cfx.getBalance(addr)));
	return bArr.reduce((a, b)=>BigInt(a)+BigInt(b), BigInt(0));
}

async function main() {
	const [,,cdm, arg1] = process.argv;
	const url = ""
	ctx.eth = await initEthSdk(arg1 || url);
	// await getBlockWithdraws(eth, 1)
	await sync()
}

if (module === require.main) {
	main()
}
