import {ethers} from "ethers";
import {Op} from "sequelize";
import {ConfigInstance} from "../../config/StatConfig";
import {
    StakingBlockSlash,
    StakingDelegation,
    StakingEvent,
    StakingEventType,
    StakingSelfDelegation,
    StakingValidator,
} from "../../model/Staking";
import {GENESIS_VALIDATORS, VALIDATOR_ABI} from "./StakingAbi";
import {getStakingCursor, stakingOption} from "./StakingSync";

/**
 * What a block's commission depends on, per validator. _distributeRewards
 * accrues `reward * commissionRate / 1e6` only while the owner (operatorAddress()
 * is owner()) meets minSelfDelegationInGwei * 1e9, so two things are needed for
 * block n:
 *
 * - the commission rate: from CommissionRateChanged events. Before the first
 *   change it is that event's old value; with no change at all, the current
 *   rate. No historical state needed.
 * - whether the owner met the minimum: it can only change at certain blocks,
 *   where it is evaluated by reading historical state, and cached in
 *   staking_self_delegation. Where the RPC has no state for the block it is
 *   approximated from the indexed shares at the current share price, and
 *   marked `approx`.
 *
 * Timing, from 0g-geth's state processor: a block's transactions run first,
 * then the reward distribution, then the slashes. So a transaction in block b
 * (a rate change, a delegation, an ownership transfer, an implementation
 * upgrade) already applies to b's reward, and a slash in b only from b + 1.
 * State is read after block b, which also holds b's own distribution; for the
 * new formula that adds one block's rewards, negligible unless the owner sits
 * exactly at the minimum.
 *
 * The minimum check itself changed with the implementation (see
 * classifyImplementation in StakingSync), tracked from the beacon's
 * ImplementationUpgraded rows:
 * - `shares-tokens` (older): shares > 0 and shares * tokens / delegatorShares,
 *   tokens without the undistributed rewards. Rewards fold into tokens only in
 *   _processDeposit, i.e. on anyone's Delegate / Undelegate / WithdrawCommission
 *   on that validator, so the result can change at exactly those blocks.
 * - `delegated-tokens`: getDelegatedTokens(owner), rewards included. Rewards
 *   grow every block, so a validator just below the minimum can cross it
 *   between evaluation points; the commission checkpoints (StakingCheck) and
 *   `check-commission` catch that.
 */

type Formula = 'shares-tokens' | 'delegated-tokens';
type Change = {block: number, old: bigint, next: bigint};
type Transfer = {block: number, next: string};
type Flow = {block: number, account: string, type: StakingEventType};
type Point = {fromBlock: number, ok: boolean};
/** a block whose post-state decides qualification from `fromBlock` on */
type Candidate = {fromBlock: number, stateBlock: number};

const STATE_READ_ATTEMPTS = 6;
const STATE_UNAVAILABLE = /missing trie node|is not available|header not found|state.*pruned/i;
/** before the first upgrade we know of, the oldest behavior */
const DEFAULT_FORMULA: Formula = 'shares-tokens';

export class CommissionModel {
    private loadedUpTo = 0;
    private slashesLoadedUpTo = 0;
    private changes = new Map<string, Change[]>();
    private transfers = new Map<string, Transfer[]>();
    private flows = new Map<string, Flow[]>();
    private slashes = new Map<string, Set<number>>();
    private upgrades: {block: number, formula: Formula}[] = [];
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

    /**
     * Loads events up to the event cursor and evaluates what blocks up to
     * `toBlock` need. `roundSlashes` are slashes of the round being computed,
     * not yet stored.
     */
    async prepare(validators: Set<string>, toBlock: number, roundSlashes: {validator: string, blockNumber: number}[] = []) {
        await this.loadEvents();
        await this.loadSlashes();
        roundSlashes.forEach(s => this.addSlash(s.validator, s.blockNumber));
        const rows = await StakingValidator.findAll({
            raw: true, attributes: ['address', 'commissionRate', 'owner', 'isGenesis'],
            where: {address: {[Op.in]: [...validators]}},
        });
        rows.forEach(r => this.validators.set(r.address, {commissionRate: r.commissionRate, owner: r.owner, isGenesis: !!r.isGenesis}));
        await this.loadTimeline([...validators]);
        for (const v of validators) {
            for (const c of this.candidates(v, toBlock)) {
                if (!this.evaluated.has(`${v}|${c.fromBlock}`)) {
                    await this.evaluate(v, c);
                }
            }
        }
    }

    rateAt(v: string, n: number): bigint {
        const list = this.changes.get(v) || [];
        let rate: bigint = null;
        for (const c of list) {
            if (c.block <= n) rate = c.next;
            else break;
        }
        if (rate != null) return rate;
        if (list.length) return list[0].old;
        return BigInt(this.validators.get(v)?.commissionRate ?? 0);
    }

    qualifiedAt(v: string, n: number): boolean {
        let ok = false;
        for (const p of this.timeline.get(v) || []) {
            if (p.fromBlock <= n) ok = p.ok;
            else break;
        }
        return ok;
    }

    formulaAt(n: number): Formula {
        let f = DEFAULT_FORMULA;
        for (const u of this.upgrades) {
            if (u.block <= n) f = u.formula;
            else break;
        }
        return f;
    }

    /** owner after block's transactions, i.e. the one block's reward is checked against */
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

    private addSlash(v: string, block: number) {
        (this.slashes.get(v) || this.slashes.set(v, new Set()).get(v)).add(block);
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
                    StakingEventType.Undelegate, StakingEventType.WithdrawCommission,
                    StakingEventType.SlashDetected, StakingEventType.ImplementationUpgraded,
                ]},
            },
        });
        const extra = (r: any) => (typeof r.extra === 'string' ? JSON.parse(r.extra) : r.extra) as any || {};
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
                    const e = extra(r);
                    this.push(this.changes, r.validator, {block, old: BigInt(e.old), next: BigInt(e.new)});
                    break;
                }
                case StakingEventType.Delegate:
                case StakingEventType.Undelegate:
                case StakingEventType.WithdrawCommission:
                    this.push(this.flows, r.validator, {block, account: r.account, type: r.eventType});
                    break;
                case StakingEventType.SlashDetected:
                    this.addSlash(r.validator, block);
                    break;
                case StakingEventType.ImplementationUpgraded:
                    this.upgrades.push({block, formula: extra(r).selfDelegation === 'delegated-tokens' ? 'delegated-tokens' : 'shares-tokens'});
                    break;
            }
        }
        this.loadedUpTo = upTo;
    }

    private async loadSlashes() {
        const rows = await StakingBlockSlash.findAll({
            raw: true, attributes: ['blockNumber', 'validator'],
            where: {blockNumber: {[Op.gt]: this.slashesLoadedUpTo}},
        });
        for (const r of rows) {
            this.addSlash(r.validator, Number(r.blockNumber));
            this.slashesLoadedUpTo = Math.max(this.slashesLoadedUpTo, Number(r.blockNumber));
        }
    }

    private async loadTimeline(validators: string[]) {
        const missing = validators.filter(v => !this.timeline.has(v));
        if (!missing.length) {
            return;
        }
        // rows without stateBlock were written under the old "applies from
        // fromBlock + 1" convention; they are ignored and re-evaluated
        const rows = await StakingSelfDelegation.findAll({
            raw: true, where: {validator: {[Op.in]: missing}, stateBlock: {[Op.ne]: null}}, order: [['fromBlock', 'asc']],
        });
        missing.forEach(v => this.timeline.set(v, []));
        for (const r of rows) {
            this.timeline.get(r.validator).push({fromBlock: Number(r.fromBlock), ok: !!r.ok});
            this.evaluated.add(`${r.validator}|${r.fromBlock}`);
        }
    }

    /** points up to `upTo` from which v's qualification may differ */
    private candidates(v: string, upTo: number): Candidate[] {
        const init = this.initBlock.get(v);
        const start: Candidate = init != null && init >= this.startBlock
            ? {fromBlock: init, stateBlock: init}
            : {fromBlock: this.startBlock, stateBlock: this.startBlock - 1};
        const byFrom = new Map<number, number>([[start.fromBlock, start.stateBlock]]);
        // a later state wins when two reasons land on the same first block
        const add = (fromBlock: number, stateBlock: number) =>
            byFrom.set(fromBlock, Math.max(byFrom.get(fromBlock) ?? -1, stateBlock));

        for (const t of this.transfers.get(v) || []) add(t.block, t.block);
        for (const b of this.slashes.get(v) || []) add(b + 1, b);
        for (let i = 0; i < this.upgrades.length; i++) {
            const u = this.upgrades[i];
            if (u.formula !== this.formulaAt(u.block - 1)) add(u.block, u.block);
        }
        for (const f of this.flows.get(v) || []) {
            if (this.formulaAt(f.block) === 'shares-tokens') {
                // any Delegate / Undelegate / WithdrawCommission folds rewards into tokens
                add(f.block, f.block);
            } else if (f.type !== StakingEventType.WithdrawCommission &&
                (this.ownerAfter(v, f.block - 1) === f.account || this.ownerAfter(v, f.block) === f.account)) {
                // only the owner's own (un)delegations move the owner's tokens
                add(f.block, f.block);
            }
        }
        return [...byFrom]
            .map(([fromBlock, stateBlock]) => ({fromBlock, stateBlock}))
            .filter(c => c.fromBlock >= start.fromBlock && c.fromBlock <= upTo)
            .sort((a, b) => a.fromBlock - b.fromBlock);
    }

    private async evaluate(v: string, c: Candidate) {
        const owner = this.ownerAfter(v, c.stateBlock);
        const formula = this.formulaAt(c.fromBlock);
        let ok: boolean, source: string;
        if (!owner || owner === ethers.constants.AddressZero) {
            ok = false;
            source = 'state_read';
        } else {
            const read = await this.readState(v, owner, c.stateBlock, formula);
            if (read != null) {
                ok = read;
                source = 'state_read';
            } else {
                ok = await this.approximate(v, owner, formula);
                source = 'approx';
            }
        }
        await StakingSelfDelegation.upsert({validator: v, fromBlock: c.fromBlock, stateBlock: c.stateBlock, owner, ok, source});
        const list = this.timeline.get(v) || this.timeline.set(v, []).get(v);
        const i = list.findIndex(p => p.fromBlock === c.fromBlock);
        if (i >= 0) list[i].ok = ok; else list.push({fromBlock: c.fromBlock, ok});
        list.sort((a, b) => a.fromBlock - b.fromBlock);
        this.evaluated.add(`${v}|${c.fromBlock}`);
    }

    /**
     * Whether the owner met the minimum after `block` under `formula`, or null
     * when no node serves that state. evmrpc.0g.ai balances over nodes of which
     * only some keep history, so a "missing trie node" is retried before giving up.
     */
    private async readState(v: string, owner: string, block: number, formula: Formula): Promise<boolean | null> {
        const c = new ethers.Contract(v, VALIDATOR_ABI, this.provider);
        const at = {blockTag: block};
        for (let attempt = 0; attempt < STATE_READ_ATTEMPTS; attempt++) {
            try {
                if (formula === 'delegated-tokens') {
                    const [tokens, minSelf] = await Promise.all([c.getDelegatedTokens(owner, at), c.minSelfDelegationInGwei(at)]);
                    return BigInt(tokens.toString()) >= BigInt(minSelf.toString()) * BigInt(1e9);
                }
                const [[, shares], tokens, total, minSelf] = await Promise.all([
                    c.getDelegation(owner, at), c.tokens(at), c.delegatorShares(at), c.minSelfDelegationInGwei(at),
                ]);
                return sharesTokensOk(BigInt(shares.toString()), BigInt(tokens.toString()), BigInt(total.toString()), BigInt(minSelf.toString()));
            } catch (e) {
                if (!STATE_UNAVAILABLE.test(`${e?.message} ${JSON.stringify(e?.error?.body || '')}`)) {
                    throw e;
                }
            }
        }
        return null;
    }

    /** the owner's current indexed shares at the current share price, against the current minimum */
    private async approximate(v: string, owner: string, formula: Formula): Promise<boolean> {
        const [val, d] = await Promise.all([
            StakingValidator.findOne({raw: true, where: {address: v}}),
            StakingDelegation.findOne({raw: true, where: {validator: v, delegator: owner}}),
        ]);
        const shares = BigInt(d?.shares ?? 0), total = BigInt(val?.delegatorShares ?? 0);
        const tokens = BigInt(val?.tokens ?? 0), minSelf = BigInt(val?.minSelfDelegationInGwei ?? 0);
        if (formula === 'shares-tokens') {
            return sharesTokensOk(shares, tokens, total, minSelf);
        }
        const value = total === BigInt(0) || tokens === BigInt(0) ? shares : shares * (tokens + BigInt(val.rewards ?? 0)) / total;
        return value >= minSelf * BigInt(1e9);
    }
}

/** the pre-bb794bcc7 _checkSelfDelegation */
function sharesTokensOk(shares: bigint, tokens: bigint, delegatorShares: bigint, minSelfGwei: bigint): boolean {
    return shares > BigInt(0) && delegatorShares > BigInt(0) && shares * tokens / delegatorShares >= minSelfGwei * BigInt(1e9);
}
