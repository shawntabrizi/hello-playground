// Deadlines for chain interactions. An unhealthy connection (stalled light
// client, half-proxied RPC gateway, wedged host bridge) typically HANGS rather
// than rejects, freezing whatever awaits it forever. Routing chain calls
// through a deadline turns a dead connection into a thrown, actionable error
// the caller's existing failure handling can surface. Retrying after one is
// safe by construction: reads are idempotent, Bulletin stores dedupe by
// content, commitments stay valid until maxCommitmentAge, and re-registers
// dry-run first.

/** Reads / dry-runs / connection handshakes — no user interaction pending.
 *  Generous enough to cover a cold light-client / host-bridge warm-up. */
export const READ_DEADLINE_MS = 45_000;

/** Transaction submission to inclusion — the chain side, no human in the loop
 *  once the signer has signed. Matches READ_DEADLINE_MS: a stalled Bulletin
 *  node hangs rather than rejects, so the deadline is the only recovery. */
export const SUBMIT_DEADLINE_MS = 45_000;

/** Anything that prompts the user over the desktop↔phone host bridge — a
 *  permission grant or a sign request the user approves on their phone. Long
 *  enough to cover a genuine first-time approval (the host's own ~60s window
 *  plus the grant landing on chain), short enough that a WEDGED bridge falls
 *  through to a retryable error instead of hanging forever. */
export const SIGN_DEADLINE_MS = 90_000;

export class DeadlineError extends Error {
    constructor(label: string) {
        super(
            `${label} took too long to respond. This is usually a temporary ` +
                `connection problem — please try again.`,
        );
        this.name = "DeadlineError";
    }
}

/** Reject with a DeadlineError if `promise` hasn't settled within `ms`. The
 *  underlying work keeps running (we can't cancel a pending RPC), but the
 *  caller stops awaiting and can retry against a fresh connection. */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new DeadlineError(label)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (cause) => {
                clearTimeout(timer);
                reject(cause);
            },
        );
    });
}
