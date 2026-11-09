import * as fs from "fs";
import * as path from "path";
import {Op} from "sequelize";
import {StakingEvent, StakingEventType} from "../../model/Staking";

/**
 * Compares the index with the Xangle indexer's Mongo exports
 * (delegate_trx.json, delegator_tokens.json), for the verification step in
 * document/staking/PLAN.md. Read-only.
 *
 * Only blocks up to the export's last block are compared. Known, expected
 * differences:
 *   - Xangle records failed delegate/undelegate txs (log_index ""); we do not.
 *   - Xangle's TOTAL_DELEGATION includes the tx.value of failed delegate txs.
 *   - Xangle accepts Delegate/Undelegate from any emitter; we only take known
 *     validators.
 */

/** mongoexport writes one pretty-printed document after another, not an array */
function parseConcatenatedJson(text: string): any[] {
    const docs = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') {
            if (depth++ === 0) start = i;
        } else if (ch === '}' && --depth === 0) {
            docs.push(JSON.parse(text.slice(start, i + 1)));
        }
    }
    return docs;
}

function mongoInt(v: any): number {
    if (v == null) return NaN;
    if (typeof v === 'object') return Number(v.$numberInt ?? v.$numberLong ?? v.$numberDecimal);
    return Number(v);
}

interface Row {
    type: 'D' | 'U'
    validator: string
    delegator: string
    amount: string
    shares: string
    block: number
}

function show(title: string, list: string[], max = 20) {
    console.log(`${title}: ${list.length}`);
    list.slice(0, max).forEach(s => console.log(`  ${s}`));
    if (list.length > max) console.log(`  ...`);
}

export async function diffWithXangle(dir: string) {
    const docs = parseConcatenatedJson(fs.readFileSync(path.join(dir, 'delegate_trx.json'), 'utf8'));
    const theirs = new Map<string, Row>();
    const failedDelegateValue = new Map<string, bigint>();
    let maxBlock = 0, failed = 0;
    for (const d of docs) {
        const block = mongoInt(d.block_number_str ?? d.block_number);
        maxBlock = Math.max(maxBlock, block || 0);
        const type = d.action_type === 'DELEGATION' ? 'D' : 'U';
        if (d.trx_status !== 'SUCCESS' || d.log_index === '') {
            failed++;
            if (type === 'D') {
                const k = d.delegator_address.toLowerCase();
                failedDelegateValue.set(k, (failedDelegateValue.get(k) ?? BigInt(0)) + BigInt(d.delegation_amount_str || 0));
            }
            continue;
        }
        theirs.set(`${d.trx_hash.toLowerCase()}|${parseInt(d.log_index, 16)}`, {
            type, block, validator: d.validator_address.toLowerCase(), delegator: d.delegator_address.toLowerCase(),
            amount: d.delegation_amount_str, shares: d.delegation_share_str,
        });
    }
    console.log(`xangle: ${docs.length} delegate_trx rows, ${failed} failed-tx rows skipped, up to block ${maxBlock}`);

    const ours = new Map<string, Row>();
    const events = await StakingEvent.findAll({
        raw: true,
        where: {
            eventType: {[Op.in]: [StakingEventType.Delegate, StakingEventType.Undelegate]},
            blockNumber: {[Op.lte]: maxBlock},
        },
    });
    for (const e of events) {
        ours.set(`${e.txHash}|${e.logIndex}`, {
            type: e.eventType === StakingEventType.Delegate ? 'D' : 'U', block: Number(e.blockNumber),
            validator: e.validator, delegator: e.account, amount: String(e.amount), shares: String(e.shares),
        });
    }
    console.log(`ours: ${ours.size} Delegate/Undelegate events up to block ${maxBlock}`);

    const onlyTheirs = [], onlyOurs = [], fieldDiff = [];
    for (const [k, t] of theirs) {
        const o = ours.get(k);
        if (!o) {
            onlyTheirs.push(`${k} ${t.type} ${t.validator} ${t.delegator} ${t.amount}`);
            continue;
        }
        for (const f of ['type', 'validator', 'delegator', 'amount', 'shares']) {
            if (String(o[f]) !== String(t[f])) {
                fieldDiff.push(`${k} ${f}: ours ${o[f]} xangle ${t[f]}`);
            }
        }
    }
    for (const [k, o] of ours) {
        if (!theirs.has(k)) {
            onlyOurs.push(`${k} ${o.type} ${o.validator} ${o.delegator} ${o.amount}`);
        }
    }
    show('events only in xangle', onlyTheirs);
    show('events only in ours', onlyOurs);
    show('field mismatches', fieldDiff);

    const tokensFile = path.join(dir, 'delegator_tokens.json');
    if (!fs.existsSync(tokensFile)) {
        return;
    }
    const oursTotal = new Map<string, bigint>();
    for (const o of ours.values()) {
        if (o.type === 'D') {
            oursTotal.set(o.delegator, (oursTotal.get(o.delegator) ?? BigInt(0)) + BigInt(o.amount));
        }
    }
    const explained = [], unexplained = [];
    for (const t of JSON.parse(fs.readFileSync(tokensFile, 'utf8'))) {
        const k = t.delegator_address.toLowerCase();
        const theirTotal = BigInt(t.TOTAL_DELEGATION);
        const ourTotal = oursTotal.get(k) ?? BigInt(0);
        if (theirTotal === ourTotal) {
            continue;
        }
        const line = `${k} xangle ${theirTotal} ours ${ourTotal}`;
        if (theirTotal - ourTotal === (failedDelegateValue.get(k) ?? BigInt(0))) {
            explained.push(`${line} (= failed delegate tx value)`);
        } else {
            unexplained.push(line);
        }
    }
    show('TOTAL_DELEGATION differs, explained by failed txs', explained, 5);
    show('TOTAL_DELEGATION differs, unexplained', unexplained);
}
