import {JsonRpcProvider} from "@ethersproject/providers/src.ts/json-rpc-provider";
import {Op, QueryTypes, Transaction} from "sequelize";
import {ConfigInstance, StakingOption} from "../../config/StatConfig";
import {KV} from "../../model/KV";
import {IStakingEvent, StakingDelegation, StakingEvent, StakingEventType, StakingValidator} from "../../model/Staking";
import {safeAddErrorLog} from "../../monitor/ErrorMonitor";
import {initEthSdk, SECOND} from "../common/utils";
import {
    decodeStakingLog,
    DecodedStakingEvent,
    DEFAULT_STAKING_CONTRACT,
    GENESIS_VALIDATORS,
    RawLog,
    STAKING_TOPICS,
    StakingDecodeError,
    VALIDATOR_TOPICS,
} from "./StakingAbi";

/**
 * Forward sync of the 0G staking contracts into staking_validator /
 * staking_delegation / staking_event. Design: document/staking/PLAN.md.
 *
 * Each round takes one block window. It first reads the Staking contract's own
 * logs, which is how validators are discovered, then the logs emitted by the
 * known validator contracts -- filtering by that address set is what keeps
 * look-alike events from arbitrary contracts out. The window's events, the
 * share deltas they imply and the cursor are written in one DB transaction.
 *
 * Reorgs are not handled: 0G finalizes every block through CometBFT, so the
 * window runs up to `latest` (minus `confirmations`, 0 by default). The RPC's
 * `finalized` tag is not used: it trails `latest` by ~10 blocks for nothing.
 */

export const KEY_STAKING_CURSOR = 'STAKING_SYNC_BLOCK';
const KEY_STAKING_GENESIS = 'STAKING_GENESIS_SEEDED';
/**
 * eth_getLogs address-array size. evmrpc.0g.ai took 1,000 without complaint
 * (2026-11-04); other RPCs cap it differently, so stay well below that.
 */
const ADDRESS_CHUNK = 500;

export function stakingOption(): Required<StakingOption> {
    const o = ConfigInstance.staking || {};
    return {
        enabled: !!o.enabled,
        contract: (o.contract || DEFAULT_STAKING_CONTRACT).toLowerCase(),
        genesis: o.genesis,
        startBlock: o.startBlock ?? 1,
        confirmations: o.confirmations ?? 0,
        // the 0G RPC's eth_getLogs limit (`query exceeds max block range 100000`)
        logRange: o.logRange ?? 100_000,
        refreshIntervalMs: o.refreshIntervalMs ?? 60 * SECOND,
    };
}

const ctx = {
    provider: null as JsonRpcProvider,
    validators: new Set<string>(),
    range: 0,
};

/**
 * Serializes a sync window against the refresher's consistency checks, which
 * compare DB shares with chain state at the cursor block and would see a
 * half-applied window as a discrepancy.
 */
let lockTail: Promise<any> = Promise.resolve();
export function withStakingLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lockTail.then(fn, fn);
    lockTail = run.catch(() => undefined);
    return run;
}

export async function getStakingCursor(): Promise<number> {
    const saved = await KV.getNumber(KEY_STAKING_CURSOR);
    return saved ?? stakingOption().startBlock - 1;
}

export async function initStakingSync() {
    const opt = stakingOption();
    ctx.provider = initEthSdk(ConfigInstance.ether?.url);
    if (!ctx.provider) {
        throw new Error(`staking sync needs config.ether.url`);
    }
    if (!GENESIS_VALIDATORS[opt.genesis]) {
        throw new Error(`config.staking.genesis must be one of ${Object.keys(GENESIS_VALIDATORS)}, got [${opt.genesis}]`);
    }
    ctx.range = opt.logRange;
    await seedGenesis(opt.genesis);
    const rows = await StakingValidator.findAll({attributes: ['address'], raw: true});
    rows.forEach(r => ctx.validators.add(r.address));
    console.log(`staking sync: ${ctx.validators.size} validators known, cursor ${await getStakingCursor()}`);
}

/**
 * Genesis validators have no ValidatorCreated/Initialized, so their rows and
 * the operator's initial shares are written once, before any event. Guarded by
 * a KV flag in the same transaction.
 */
async function seedGenesis(network: string) {
    if (await KV.getString(KEY_STAKING_GENESIS, '')) {
        return;
    }
    const list = GENESIS_VALIDATORS[network];
    await StakingValidator.sequelize.transaction(async dbTx => {
        for (const g of list) {
            await StakingValidator.findOrCreate({
                where: {address: g.address},
                defaults: {address: g.address, isGenesis: true, createdBlock: 0, initializedBlock: 0, operator: g.operator},
                transaction: dbTx,
            });
        }
        await applyShareDeltas(new Map(list.map(g => [pairKey(g.address, g.operator), {
            delta: BigInt(g.amount), firstBlock: 0, lastBlock: 0, firstAt: null, lastAt: null,
        }])), dbTx);
        await KV.upsert({key: KEY_STAKING_GENESIS, value: network}, {transaction: dbTx});
    });
    console.log(`staking sync: seeded ${list.length} genesis validators (${network})`);
}

async function safeHead(): Promise<number> {
    return (await ctx.provider.getBlockNumber()) - stakingOption().confirmations;
}

async function getLogs(address: string | string[], topics: string[], from: number, to: number): Promise<RawLog[]> {
    const logs = await ctx.provider.getLogs({address: address as any, topics: [topics], fromBlock: from, toBlock: to});
    return logs as any as RawLog[];
}

function pairKey(validator: string, delegator: string) {
    return `${validator}|${delegator}`;
}

interface ShareDelta {
    delta: bigint
    firstBlock: number
    lastBlock: number
    firstAt: Date
    lastAt: Date
}

function addDelta(map: Map<string, ShareDelta>, validator: string, delegator: string,
                  delta: bigint, block: number, at: Date) {
    const k = pairKey(validator, delegator);
    const cur = map.get(k);
    if (cur) {
        cur.delta += delta;
        cur.lastBlock = block;
        cur.lastAt = at;
    } else {
        map.set(k, {delta, firstBlock: block, lastBlock: block, firstAt: at, lastAt: at});
    }
}

/** Adds deltas onto staking_delegation, creating rows as needed. */
async function applyShareDeltas(map: Map<string, ShareDelta>, dbTx: Transaction) {
    if (!map.size) {
        return;
    }
    const values = [];
    const replacements = [];
    for (const [k, d] of map) {
        const [validator, delegator] = k.split('|');
        values.push('(?,?,?,?,?,?,?)');
        replacements.push(validator, delegator, d.delta.toString(), d.firstBlock, d.lastBlock, d.firstAt, d.lastAt);
    }
    const t = StakingDelegation.getTableName();
    // assignments run left to right and see earlier ones, so lastAt goes before lastBlock
    const sql = `insert into ${t} (validator, delegator, shares, firstBlock, lastBlock, firstAt, lastAt)
        values ${values.join(',')}
        on duplicate key update shares = shares + values(shares),
            lastAt = if(values(lastBlock) >= lastBlock, values(lastAt), lastAt),
            lastBlock = greatest(lastBlock, values(lastBlock))`;
    await StakingDelegation.sequelize.query(sql, {type: QueryTypes.INSERT, replacements, transaction: dbTx});
}

interface WindowResult {
    events: number
    newValidators: number
}

/** Reads and applies [from, to]. Throws on RPC failure; the caller shrinks the window. */
async function syncWindow(from: number, to: number): Promise<WindowResult> {
    const opt = stakingOption();
    const stakingLogs = await getLogs(opt.contract, STAKING_TOPICS, from, to);

    // decode first: validators created in this window must be in the address
    // set before their own logs are requested
    const decoded: {log: RawLog, ev: DecodedStakingEvent}[] = [];
    const newValidators = new Set<string>();
    const decode = (log: RawLog) => {
        try {
            const ev = decodeStakingLog(log);
            if (ev) {
                decoded.push({log, ev});
            }
            return ev;
        } catch (e) {
            if (e instanceof StakingDecodeError) {
                console.log(`staking sync: skip undecodable log: ${e.message}`);
                safeAddErrorLog('staking', 'decode', e);
                return null;
            }
            throw e;
        }
    };
    for (const log of stakingLogs) {
        const ev = decode(log);
        if (ev && !ctx.validators.has(ev.validator) && (
            ev.eventType === StakingEventType.ValidatorCreated || ev.eventType === StakingEventType.ValidatorInitialized)) {
            newValidators.add(ev.validator);
        }
    }
    const addresses = [...ctx.validators, ...newValidators];
    for (let i = 0; i < addresses.length; i += ADDRESS_CHUNK) {
        const logs = await getLogs(addresses.slice(i, i + ADDRESS_CHUNK), VALIDATOR_TOPICS, from, to);
        logs.forEach(decode);
    }
    decoded.sort((a, b) => a.log.blockNumber - b.log.blockNumber || a.log.logIndex - b.log.logIndex);

    const blockTime = new Map<number, Date>();
    for (const n of new Set(decoded.map(d => d.log.blockNumber))) {
        const block = await ctx.provider.getBlock(n);
        blockTime.set(n, new Date(block.timestamp * 1000));
    }

    let inserted = 0;
    await withStakingLock(() => StakingEvent.sequelize.transaction(async dbTx => {
        // skip what an earlier (e.g. manual, overlapping) run already applied,
        // so share deltas are never counted twice
        const existing = new Set((await StakingEvent.findAll({
            attributes: ['blockNumber', 'logIndex', 'validator'], raw: true, transaction: dbTx,
            where: {blockNumber: {[Op.between]: [from, to]}, logIndex: {[Op.gte]: 0}},
        })).map(r => `${r.blockNumber}|${r.logIndex}|${r.validator}`));

        // before an upgrade, initialization also emitted a Delegate for the
        // operator in the same tx; credit the initial stake only once
        const delegatesInTx = new Set(decoded
            .filter(d => d.ev.eventType === StakingEventType.Delegate)
            .map(d => `${d.log.transactionHash}|${d.ev.validator}|${d.ev.account}`));

        const rows: IStakingEvent[] = [];
        const deltas = new Map<string, ShareDelta>();
        for (const {log, ev} of decoded) {
            if (existing.has(`${log.blockNumber}|${log.logIndex}|${ev.validator}`)) {
                continue;
            }
            const at = blockTime.get(log.blockNumber);
            rows.push({
                blockNumber: log.blockNumber, blockHash: log.blockHash, createdAt: at,
                txHash: log.transactionHash, txIndex: log.transactionIndex, logIndex: log.logIndex,
                validator: ev.validator, eventType: ev.eventType, account: ev.account, counterparty: ev.counterparty,
                amount: ev.amount, shares: ev.shares, extra: ev.extra,
            });
            switch (ev.eventType) {
                case StakingEventType.ValidatorCreated:
                    await upsertValidator(ev.validator, {createdBlock: log.blockNumber, createdAt: at}, dbTx);
                    break;
                case StakingEventType.ValidatorInitialized:
                    await upsertValidator(ev.validator, {initializedBlock: log.blockNumber, operator: ev.account}, dbTx);
                    if (!delegatesInTx.has(`${log.transactionHash}|${ev.validator}|${ev.account}`)) {
                        // the pool is empty at initialization, so shares == amount
                        addDelta(deltas, ev.validator, ev.account, BigInt(ev.amount), log.blockNumber, at);
                    }
                    break;
                case StakingEventType.ValidatorExited:
                    await upsertValidator(ev.validator, {exitedBlock: log.blockNumber}, dbTx);
                    break;
                case StakingEventType.Delegate:
                    addDelta(deltas, ev.validator, ev.account, BigInt(ev.shares), log.blockNumber, at);
                    break;
                case StakingEventType.Undelegate:
                    addDelta(deltas, ev.validator, ev.account, -BigInt(ev.shares), log.blockNumber, at);
                    break;
            }
        }
        if (rows.length) {
            await StakingEvent.bulkCreate(rows, {transaction: dbTx, ignoreDuplicates: true});
        }
        await applyShareDeltas(deltas, dbTx);
        await KV.saveNumber(KEY_STAKING_CURSOR, to, dbTx);
        inserted = rows.length;
    }));
    // only after commit, so a rolled-back window does not leave phantom entries
    newValidators.forEach(v => ctx.validators.add(v));
    return {events: inserted, newValidators: newValidators.size};
}

async function upsertValidator(address: string, fields: {[k: string]: any}, dbTx: Transaction) {
    const cols = Object.keys(fields);
    const t = StakingValidator.getTableName();
    const sql = `insert into ${t} (address, ${cols.join(', ')}) values (?, ${cols.map(() => '?').join(', ')})
        on duplicate key update ${cols.map(c => `${c} = values(${c})`).join(', ')}`;
    await StakingValidator.sequelize.query(sql, {
        type: QueryTypes.INSERT, replacements: [address, ...cols.map(c => fields[c])], transaction: dbTx,
    });
}

/** One round. Returns true when caught up with the safe head. */
export async function stakingSyncOnce(): Promise<boolean> {
    const cursor = await getStakingCursor();
    const head = await safeHead();
    if (cursor >= head) {
        return true;
    }
    const from = cursor + 1;
    const to = Math.min(head, cursor + ctx.range);
    const {events, newValidators} = await syncWindow(from, to);
    if (events || newValidators) {
        console.log(`staking sync: blocks ${from}-${to}, ${events} events, ${newValidators} new validators`);
    }
    // recover the configured window after a shrink
    ctx.range = Math.min(stakingOption().logRange, ctx.range * 2);
    return to >= head;
}

export async function runStakingSync() {
    let delay = 0;
    try {
        const caughtUp = await stakingSyncOnce();
        delay = caughtUp ? SECOND * 5 : 0;
    } catch (e) {
        // most RPC failures here are an oversized getLogs window
        ctx.range = Math.max(1, Math.floor(ctx.range / 2));
        console.log(`staking sync failed, window now ${ctx.range} blocks:`, e?.message || e);
        safeAddErrorLog('staking', 'sync', e);
        delay = SECOND * 10;
    }
    setTimeout(runStakingSync, delay);
}
