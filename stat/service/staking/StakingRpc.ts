import {ethers} from "ethers";

/**
 * The 0G public RPCs limit each client IP to about 50 calls per short window
 * (`-32005 request rate exceeded: Too many requests (exceeds 50), try again
 * after 6ms`), and a JSON-RPC batch counts every call in it. On a server that
 * shares its IP with other processes using the same RPC that limit is hit all
 * the time, so a rate-limit rejection is not a failure: it is retried here
 * with backoff, separately from (and far more often than) real errors.
 */

const RATE_LIMIT_ATTEMPTS = 30;
const MAX_DELAY_MS = 5000;

/**
 * A rate-limit rejection, or ethers' "could not detect network" (what a
 * rejected eth_chainId turns into; a real outage is retried too, harmlessly).
 */
export function isRateLimited(e: any): boolean {
    const text = typeof e === 'string' ? e : `${e?.code} ${e?.error?.code} ${e?.message} ${e?.body || ''} ${JSON.stringify(e?.error || '')}`;
    return /-32005|request rate exceeded|too many requests|could not detect network|noNetwork/i.test(text);
}

function backoff(attempt: number): Promise<void> {
    const ms = Math.min(MAX_DELAY_MS, 200 * 2 ** attempt) * (0.5 + Math.random());
    return new Promise(r => setTimeout(r, ms));
}

/** Runs `fn`, retrying while the RPC rejects it for rate; other errors are thrown as is. */
export async function withRateRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (!isRateLimited(e) || attempt >= RATE_LIMIT_ATTEMPTS) {
                throw e;
            }
            await backoff(attempt);
        }
    }
}

/**
 * One JSON-RPC batch, results in call order (an entry's `error` is kept for
 * the caller). A rate-limited batch is retried as a whole.
 */
export async function postBatch(url: string, calls: {method: string, params: any[]}[]): Promise<{result?: any, error?: any}[]> {
    const body = calls.map((c, id) => ({jsonrpc: '2.0', id, ...c}));
    return withRateRetry(async () => {
        const resp = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
        const json: any = await resp.json();
        if (!Array.isArray(json)) {
            // a rejected batch comes back as a single error object
            throw new Error(`rpc: ${JSON.stringify(json).slice(0, 300)}`);
        }
        const limited = json.find(r => r.error && isRateLimited(JSON.stringify(r.error)));
        if (limited) {
            throw new Error(`rpc: ${JSON.stringify(limited.error)}`);
        }
        const byId = new Map(json.map(r => [r.id, r]));
        return calls.map((_, id) => byId.get(id) || {error: 'missing response'});
    });
}

/**
 * ethers' JsonRpcProvider re-detects the network (an eth_chainId) before
 * almost every call; under a rate limit that doubles the request count, and a
 * rejected eth_chainId surfaces as "could not detect network". These detect
 * it once.
 */
class StaticJsonRpcBatchProvider extends ethers.providers.JsonRpcBatchProvider {
    private detected: Promise<ethers.providers.Network>;

    detectNetwork(): Promise<ethers.providers.Network> {
        if (!this.detected) {
            this.detected = super.detectNetwork().catch(e => {
                this.detected = null;
                throw e;
            });
        }
        return this.detected;
    }
}

export function staticProvider(url: string): ethers.providers.JsonRpcProvider {
    return new ethers.providers.StaticJsonRpcProvider(url);
}

export function staticBatchProvider(url: string): ethers.providers.JsonRpcBatchProvider {
    return new StaticJsonRpcBatchProvider(url);
}
