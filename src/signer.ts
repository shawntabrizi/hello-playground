// Host account flow via @parity/product-sdk-signer (SignerManager + HostProvider).
//
// This is the single home for the SignerManager. The host's product-account
// signer routes through host_create_transaction (the HostProvider's
// `getSigner()`), so AH-Next's custom signed extensions (AsPgas,
// AuthorizeValueTransfer, …) pass through to the host as raw bytes — the same
// "createTransaction" behaviour the previous novasama path relied on, now
// supplied by the Product SDK.
//
// The public API (connectHostAccount / signInToHost / getHostState /
// useHostState / HostState / HostStatus / HostAccount) is preserved so
// account.ts and accountSession.ts are unchanged. The host status is derived
// from the SignerManager's connect result + state.

import { useSyncExternalStore } from "react";
import {
    HostProvider,
    HostUnavailableError,
    SignerManager,
    isHostError,
    type SignerAccount,
} from "@parity/product-sdk-signer";
import type { PolkadotSigner } from "polkadot-api";
import { SIGN_DEADLINE_MS, withDeadline } from "./lib/deadline.ts";

const DEFAULT_PRODUCT_ACCOUNT_DOT_NS = "dotpages.dot";
const PRODUCT_ACCOUNT_DERIVATION_INDEX = 0;

function isLoopback(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function getProductAccountIdentifier(): string {
    const configured = import.meta.env.VITE_PRODUCT_ACCOUNT_ID?.trim();
    if (configured) return configured;

    if (typeof window === "undefined") return DEFAULT_PRODUCT_ACCOUNT_DOT_NS;
    const { hostname } = window.location;
    // A loopback dev origin (localhost:5173) is not a product the host can
    // resolve — asking for it leaves the host derivation hanging. Fall back to
    // the canonical product so localhost-in-host can authenticate as dotpages.
    if (isLoopback(hostname)) return DEFAULT_PRODUCT_ACCOUNT_DOT_NS;

    // dotli exposes hosted products as `<name>.<gateway>` (e.g.
    // `dotpages.dot.li`). Map back to the canonical `<name>.dot`
    // identifier the host signs against.
    const labels = hostname.toLowerCase().split(".");
    if (labels.length === 3) return `${labels[0]}.dot`;

    if (hostname.endsWith(".dot")) return hostname;
    return DEFAULT_PRODUCT_ACCOUNT_DOT_NS;
}

export interface HostAccount {
    /** SS58 string derived from the host's product public key. */
    address: string;
    publicKey: Uint8Array;
    /** dotli primary username, when the host exposes one. */
    displayName: string | null;
    /** PAPI signer routed via host_create_transaction. */
    signer: PolkadotSigner;
}

export type HostStatus = "idle" | "connecting" | "ready" | "signed-out" | "error";

export interface HostState {
    status: HostStatus;
    account: HostAccount | null;
    error: string | null;
}

let state: HostState = { status: "idle", account: null, error: null };
const listeners = new Set<() => void>();

function setState(next: HostState) {
    state = next;
    for (const cb of listeners) cb();
}

// The host derives a single product account for this dapp (no picker), so we
// pin the HostProvider to the dotNS-derived product account. `requestName`
// stays on (default) — dotpages surfaces the host wallet's primary username as
// the display name; the SDK fetches it at connect.
export const signerManager = new SignerManager({
    dappName: "dotpages",
    createProvider: (type) =>
        type === "host"
            ? new HostProvider({
                  productAccount: {
                      dotNsIdentifier: getProductAccountIdentifier(),
                      derivationIndex: PRODUCT_ACCOUNT_DERIVATION_INDEX,
                  },
              })
            : new HostProvider(),
});

function accountToHostAccount(account: SignerAccount): HostAccount {
    return {
        address: account.address,
        publicKey: account.publicKey,
        displayName: account.name,
        // The HostProvider signer IS a PAPI PolkadotSigner routed via
        // host_create_transaction, so AH-Next's custom signed extensions pass
        // through as raw bytes.
        signer: account.getSigner(),
    };
}

// Reflect SignerManager state into the dotpages HostState shape on every change.
signerManager.subscribe(() => {
    const s = signerManager.getState();
    if (s.status === "connected" && s.selectedAccount) {
        setState({
            status: "ready",
            account: accountToHostAccount(s.selectedAccount),
            error: null,
        });
    } else if (s.status === "connecting") {
        setState({ status: "connecting", account: null, error: state.error });
    }
    // "disconnected" is left to connectHostAccount's result mapping — a bare
    // disconnect after a failed connect must keep the signed-out/error verdict.
});

// Map a SignerManager connect failure onto the dotpages host status. A missing
// host ("not inside a Polkadot host") → error so the UI offers the
// extension/dev fallback; anything else (host present but no session, user
// rejected) → signed-out so the UI offers a retryable "Sign in" CTA.
function statusForConnectError(error: unknown): HostStatus {
    if (error instanceof HostUnavailableError) return "error";
    if (error instanceof Error && isHostError(error as never)) {
        // HostDisconnected / HostRejected — present but no usable session.
        return "signed-out";
    }
    return "signed-out";
}

/**
 * Resolve the app-scoped product account from the host. Distinguishes
 * "host has no session" (→ `signed-out`, fixable via signInToHost)
 * from "host unavailable / failed" (→ `error`).
 */
export async function connectHostAccount(): Promise<HostState> {
    if (state.status === "connecting") return state;
    setState({ status: "connecting", account: null, error: null });

    const result = await signerManager.connect();
    if (result.ok) {
        const account = signerManager.getState().selectedAccount;
        if (account) {
            setState({
                status: "ready",
                account: accountToHostAccount(account),
                error: null,
            });
            return state;
        }
        // connect() can resolve `ok` with no selected account (host returned
        // accounts but none matched the dotNS-derived product account). Treat
        // as signed-out so the UI offers a sign-in CTA.
        setState({ status: "signed-out", account: null, error: null });
        return state;
    }

    const status = statusForConnectError(result.error);
    setState({
        status,
        account: null,
        error: status === "error" ? result.error.message : null,
    });
    return state;
}

/** Open the host's sign-in UI, then re-resolve the product account. The host
 *  shows its own session dialog inside `connect()` when it has no session. */
export async function signInToHost(): Promise<HostState> {
    // A fresh connect after the user asked to sign in: clear any prior verdict
    // so the host gets a clean attempt (it surfaces its own login UI).
    signerManager.disconnect();
    return connectHostAccount();
}

export function getHostState(): HostState {
    return state;
}

export function useHostState(): HostState {
    return useSyncExternalStore(
        (cb) => {
            listeners.add(cb);
            return () => {
                listeners.delete(cb);
            };
        },
        () => state,
    );
}

/**
 * Make the host account ready to submit: connect (if needed) and surface the
 * host's session dialog. Deadline-bound because the host bridge can WEDGE (the
 * WebView frozen while the user approves on their phone) and never settle.
 * Returns the host PolkadotSigner.
 */
export async function ensureSignerReady(): Promise<PolkadotSigner> {
    const hostState = await withDeadline(
        connectHostAccount(),
        SIGN_DEADLINE_MS,
        "Connecting your account",
    );
    if (hostState.status !== "ready" || !hostState.account) {
        throw new Error(hostState.error ?? "No host account available");
    }
    return hostState.account.signer;
}
