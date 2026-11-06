import {ethers} from "ethers";
import {Op} from "sequelize";
import {ConfigInstance} from "../../config/StatConfig";
import {StakingDelegation, StakingEvent, StakingEventType, StakingSelfDelegation, StakingValidator} from "../../model/Staking";
import {GENESIS_VALIDATORS, VALIDATOR_ABI} from "./StakingAbi";
import {getStakingCursor, stakingOption} from "./StakingSync";

/**
 * What a block's commission depends on, per validator. _distributeRewards
 * accrues `reward * commissionRate / 1e6` only while
 * getDelegatedTokens(owner) >= minSelfDelegationInGwei * 1e9
 * (operatorAddress() is owner()), so two things are needed for block n:
 *
 * - the commission rate: from CommissionRateChanged events. Before the first
 *   change it is that event's old value; with no change at all, the current
 *   rate. No historical state needed.
 * - whether the owner met the minimum: it can only change when the owner
 *   delegates or undelegates, ownership moves, or the owner is slashed, so it
 *   is evaluated at those blocks (and at the collection start) by reading
 *   historical state, and cached in staking_self_delegation. Where the RPC has
 *   no state for the block (testnet prunes it) it is approximated from the
 *   indexed shares at the current share price, and marked `approx`.
 *
 * Convention: a change in block b applies from block b + 1, i.e. block n sees
 * the state after block n - 1. Between evaluation points the owner's token
 * value only grows with rewards, so a validator just below the minimum can
 * cross it unseen; `check-commission` compares against chain state to catch
 * that.
 */

type Change = {block: number, old: bigint, next: bigint};
type Transfer = {block: number, next: string};
type Point = {fromBlock: number, ok: boolean};

const STATE_READ_ATTEMPTS = 6;
const STATE_UNAVAILABLE = /missing trie node|is not available|header not found|state.*pruned/i;

export class CommissionModel {
    private loadedUpTo = 0;
    private changes = new Map<string, Change[]>();
    private transfers = new Map<string, Transfer[]>();
    /** blocks with a Delegate/Undelegate per (validator, account) */
    private flows = new Map<string, Map<string, number[]>>();
    private slashes = new Map<string, number[]>();
    private initBlock = new Map<string, number>();
    private timeline = new Map<string, Point[]>();
    private evaluated = new Set<string>();
    private validators = new Map<string, {commissionRate: number, owner: string, isGenesis: boolean}>();
    private genesisOperator = new Map<string, string>();
    private provider: ethers.providers.JsonRpcProvider;

    constructor(private startBlock: number) {
        this.provider = new ethers.providers.JsonRpcProvider(ConfigInstance.ether.url);
        for (const g of GENESIS_VALIDATORS[stakingOption().genesis] || []) {
            this.genesisOperator.set(g.address, g.operator);
        }
    }

    /** Loads events up to the event cursor and evaluates what blocks up to `toBlock` need. */
    async prepare(validators: Set<string>, toBlock: number) {
        await this.loadEvents();
        const rows = await StakingValidator.findAll({
            raw: true, attributes: ['address', 'commissionRate', 'owner', 'isGenesis'],
            where: {address: {[Op.in]: [...validators]}},
        });
        rows.forEach(r => this.validators.set(r.address, {commissionRate: r.commissionRate, owner: r.owner, isGenesis: !!r.isGenesis}));
        await this.loadTimeline([...validators]);
        for (const v of validators) {
            for (const c of this.candidates(v, toBlock - 1)) {
                if (!this.evaluated.has(`${v}|${c}`)) {
                    await this.evaluate(v, c);
                }
            }
        }
    }

    rateAt(v: string, n: number): bigint {
        const list = this.changes.get(v) || [];
        let rate: bigint = null;
        for (const c of list) {
            if (c.block < n) rate = c.next;
            else break;
        }
        if (rate != null) return rate;
        if (list.length) return list[0].old;
        return BigInt(this.validators.get(v)?.commissionRate ?? 0);
    }

    qualifiedAt(v: string, n: number): boolean {
        let ok = false;
        for (const p of this.timeline.get(v) || []) {
            if (p.fromBlock < n) ok = p.ok;
            else break;
        }
        return ok;
    }

    /** owner for blocks after `block` */
    ownerAfter(v: string, block: number): string {
        let owner = this.genesisOperator.get(v) || null;
        for (const t of this.transfers.get(v) || []) {
            if (t.block <= block) owner = t.next;
            else break;
        }
        return owner || this.validators.get(v)?.owner || null;
    }

    private push<T>(map: Map<string, T[]>, k: string, item: T) {
        (map.get(k) || map.set(k, []).get(k)).push(item);
    }

    private async loadEvents() {
        const upTo = await getStakingCursor();
        if (upTo <= this.loadedUpTo) {
            return;
        }
        const rows = await StakingEvent.findAll({
            raw: true, order: [['blockNumber', 'asc'], ['logIndex', 'asc']],
            attributes: ['blockNumber', 'validator', 'eventType', 'account', 'counterparty', 'extra'],
            where: {
                blockNumber: {[Op.gt]: this.loadedUpTo, [Op.lte]: upTo},
                eventType: {[Op.in]: [
                    StakingEventType.ValidatorInitialized, StakingEventType.OwnershipTransferred,
                    StakingEventType.CommissionRateChanged, StakingEventType.Delegate,
                    StakingEventType.Undelegate, StakingEventType.SlashDetected,
                ]},
            },
        });
        for (const r of rows) {
            const block = Number(r.blockNumber);
            switch (r.eventType) {
                case StakingEventType.ValidatorInitialized:
                    this.initBlock.set(r.validator, block);
                    break;
                case StakingEventType.OwnershipTransferred:
                    this.push(this.transfers, r.validator, {block, next: r.counterparty});
                    break;
                case StakingEventType.CommissionRateChanged: {
                    const e = (typeof r.extra === 'string' ? JSON.parse(r.extra) : r.extra) as any;
                    this.push(this.changes, r.validator, {block, old: BigInt(e.old), next: BigInt(e.new)});
                    break;
                }
                case StakingEventType.Delegate:
                case StakingEventType.Undelegate: {
                    const m = this.flows.get(r.validator) || this.flows.set(r.validator, new Map()).get(r.validator);
                    (m.get(r.account) || m.set(r.account, []).get(r.account)).push(block);
                    break;
                }
                case StakingEventType.SlashDetected:
                    this.push(this.slashes, r.validator, block);
                    break;
            }
        }
        this.loadedUpTo = upTo;
    }

    private async loadTimeline(validators: string[]) {
        const missing = validators.filter(v => !this.timeline.has(v));
        if (!missing.length) {
            return;
        }
        const rows = await StakingSelfDelegation.findAll({
            raw: true, where: {validator: {[Op.in]: missing}}, order: [['fromBlock', 'asc']],
        });
        missing.forEach(v => this.timeline.set(v, []));
        for (const r of rows) {
            this.timeline.get(r.validator).push({fromBlock: Number(r.fromBlock), ok: !!r.ok});
            this.evaluated.add(`${r.validator}|${r.fromBlock}`);
        }
    }

    /** blocks up to `upTo` at which v's qualification may have changed */
    private candidates(v: string, upTo: number): number[] {
        const start = Math.max(this.startBlock - 1, this.initBlock.get(v) ?? 0);
        const set = new Set<number>([start]);
        for (const t of this.transfers.get(v) || []) set.add(t.block);
        for (const b of this.slashes.get(v) || []) set.add(b);
        for (const [account, blocks] of this.flows.get(v) || []) {
            for (const b of blocks) {
                // only the owner's own (un)delegations move the owner's tokens
                if (this.ownerAfter(v, b - 1) === account || this.ownerAfter(v, b) === account) set.add(b);
            }
        }
        return [...set].filter(b => b >= start && b <= upTo).sort((a, b) => a - b);
    }

    private async evaluate(v: string, block: number) {
        const owner = this.ownerAfter(v, block);
        let ok: boolean, source: string;
        if (!owner || owner === ethers.constants.AddressZero) {
            ok = false;
            source = 'state_read';
        } else {
            const state = await this.readState(v, owner, block);
            if (state) {
                ok = state.tokens >= state.minSelf * BigInt(1e9);
                source = 'state_read';
            } else {
                ok = await this.approximate(v, owner);
                source = 'approx';
            }
        }
        await StakingSelfDelegation.upsert({validator: v, fromBlock: block, owner, ok, source});
        const list = this.timeline.get(v) || this.timeline.set(v, []).get(v);
        list.push({fromBlock: block, ok});
        list.sort((a, b) => a.fromBlock - b.fromBlock);
        this.evaluated.add(`${v}|${block}`);
    }

    /**
     * getDelegatedTokens(owner) and minSelfDelegationInGwei at `block`, or null
     * when no node serves that state. evmrpc.0g.ai balances over nodes of which
     * only some keep history, so a "missing trie node" is retried before giving up.
     */
    private async readState(v: string, owner: string, block: number) {
        const c = new ethers.Contract(v, VALIDATOR_ABI, this.provider);
        for (let attempt = 0; attempt < STATE_READ_ATTEMPTS; attempt++) {
            try {
                const [tokens, minSelf] = await Promise.all([
                    c.getDelegatedTokens(owner, {blockTag: block}), c.minSelfDelegationInGwei({blockTag: block}),
                ]);
                return {tokens: BigInt(tokens.toString()), minSelf: BigInt(minSelf.toString())};
            } catch (e) {
                if (!STATE_UNAVAILABLE.test(`${e?.message} ${JSON.stringify(e?.error?.body || '')}`)) {
                    throw e;
                }
            }
        }
        return null;
    }

    /** the owner's current indexed shares at the current share price, against the current minimum */
    private async approximate(v: string, owner: string): Promise<boolean> {
        const [val, d] = await Promise.all([
            StakingValidator.findOne({raw: true, where: {address: v}}),
            StakingDelegation.findOne({raw: true, where: {validator: v, delegator: owner}}),
        ]);
        const shares = BigInt(d?.shares ?? 0), total = BigInt(val?.delegatorShares ?? 0);
        const tokens = total === BigInt(0) ? shares : shares * (BigInt(val.tokens ?? 0) + BigInt(val.rewards ?? 0)) / total;
        return tokens >= BigInt(val?.minSelfDelegationInGwei ?? 0) * BigInt(1e9);
    }
}
