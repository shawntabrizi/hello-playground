// The login / account widget shared by the homepage and the editor. Reads the
// app-wide session (accountSession.ts) so every surface shows the same account.
//
// Works across all three environments: inside a Polkadot host it auto-connects
// (and offers "Sign in to Polkadot" when the host has no session); in a plain
// browser it connects a wallet extension; with no wallet it points the user at
// one and offers the dev account for local testing.

import { useEffect, useRef, useState } from "react";
import { truncateAddress } from "@parity/product-sdk-address";
import { avatarColors, avatarInitial } from "./avatar.ts";
import { copyText } from "./clipboard.ts";
import { getAssetHubClient } from "./lib/polkadot/clients.ts";
import { formatNative, getNativeUnit } from "./lib/polkadot/native.ts";
import {
    connectExtension,
    disconnect,
    setUseDev,
    signInHost,
    useAccountSession,
} from "./accountSession.ts";

// pjs-signer drives extension support, so point at the canonical Polkadot{.js}
// extension; any SubWallet/Talisman install also satisfies the injected check.
const WALLET_URL = "https://polkadot.js.org/extension/";

const SOURCE_LABEL: Record<string, string> = {
    host: "Polkadot",
    extension: "Wallet",
    dev: "Dev account",
};

// Small inline glyphs — keeps the widget dependency-free (no icon library).
function ChevronIcon() {
    return (
        <svg className="account-caret" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}
function UserIcon() {
    return (
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <circle cx="8" cy="5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path
                d="M3 13.2c0-2.5 2.2-3.8 5-3.8s5 1.3 5 3.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
            />
        </svg>
    );
}
function CopyIcon({ done }: { done: boolean }) {
    return done ? (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
                d="M3.5 8.5l3 3 6-6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    ) : (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path
                d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

/** Gradient identity chip derived from the address, with a source-coloured
 *  presence badge. `size` drives the trigger (sm) vs menu-header (lg) variants. */
function Avatar({
    seed,
    initial,
    source,
    size,
}: {
    seed: string;
    initial: string;
    source: string;
    size: "sm" | "lg";
}) {
    const { from, to } = avatarColors(seed);
    return (
        <span
            className={`account-avatar account-avatar-${size}`}
            style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
            aria-hidden="true"
        >
            {initial}
            <span className={`account-presence source-${source}`} />
        </span>
    );
}

type BalanceState =
    | { status: "loading" }
    | { status: "ready"; text: string; zero: boolean }
    | { status: "error" };

/** Free balance on Asset Hub for the open menu's account. Deploying spends real
 *  balance — the .dot price and the pallet-revive storage deposits are not
 *  covered by host fee sponsorship — so the account view has to show whether
 *  there is any. Fetched only while the menu is open: it is a chain read, and
 *  nothing outside the menu displays it. */
function useNativeBalance(address: string | null, enabled: boolean): BalanceState {
    const [state, setState] = useState<BalanceState>({ status: "loading" });
    useEffect(() => {
        if (!address || !enabled) return;
        let cancelled = false;
        setState({ status: "loading" });
        (async () => {
            try {
                const [{ api }, unit] = await Promise.all([
                    getAssetHubClient(),
                    getNativeUnit(),
                ]);
                const info = await api.query.System.Account.getValue(address);
                if (cancelled) return;
                setState({
                    status: "ready",
                    text: formatNative(info.data.free, unit),
                    zero: info.data.free === 0n,
                });
            } catch {
                if (!cancelled) setState({ status: "error" });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [address, enabled]);
    return state;
}

export default function AccountBar() {
    const { activeAccount, source, resolving, hostSignedOut, hasExtension, usingDev, error } =
        useAccountSession();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    // Close the menu on an outside click / Escape.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        try {
            await fn();
        } finally {
            setBusy(false);
        }
    };

    const copyAddress = async () => {
        if (!activeAccount) return;
        if (await copyText(activeAccount.address)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1300);
        }
    };

    const src = source ?? "none";
    const connecting = resolving && !activeAccount;
    const balance = useNativeBalance(activeAccount?.address ?? null, open);

    return (
        <div className="account-bar" ref={ref}>
            <button
                type="button"
                className={[
                    "account-trigger",
                    activeAccount ? "is-active" : "is-signin",
                    open ? "is-open" : "",
                ]
                    .filter(Boolean)
                    .join(" ")}
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={connecting}
            >
                {activeAccount ? (
                    <Avatar
                        seed={activeAccount.address}
                        initial={avatarInitial(activeAccount.displayName)}
                        source={src}
                        size="sm"
                    />
                ) : (
                    <span className="account-trigger-icon" aria-hidden="true">
                        <UserIcon />
                    </span>
                )}
                <span className="account-trigger-name">
                    {activeAccount ? activeAccount.displayName : connecting ? "Connecting…" : "Sign in"}
                </span>
                <ChevronIcon />
            </button>

            {open && (
                <div className="account-menu" role="menu">
                    {activeAccount ? (
                        <>
                            <div className="account-menu-head">
                                <Avatar
                                    seed={activeAccount.address}
                                    initial={avatarInitial(activeAccount.displayName)}
                                    source={src}
                                    size="lg"
                                />
                                <div className="account-menu-id">
                                    <div className="account-menu-name">
                                        {activeAccount.displayName}
                                    </div>
                                    <div className="account-menu-source">
                                        <span className={`source-dot source-${src}`} aria-hidden="true" />
                                        {SOURCE_LABEL[src] ?? "Account"}
                                    </div>
                                </div>
                            </div>

                            <button
                                type="button"
                                className="account-address"
                                onClick={copyAddress}
                                title="Copy address"
                            >
                                <span className="account-address-text">
                                    {truncateAddress(activeAccount.address)}
                                </span>
                                <span className={`account-address-copy${copied ? " is-done" : ""}`}>
                                    <CopyIcon done={copied} />
                                    {copied ? "Copied" : "Copy"}
                                </span>
                            </button>

                            <div className="account-balance">
                                <span className="account-balance-label">Balance</span>
                                <span
                                    className={`account-balance-value${
                                        balance.status === "ready" && balance.zero ? " is-empty" : ""
                                    }`}
                                >
                                    {balance.status === "ready"
                                        ? balance.text
                                        : balance.status === "error"
                                          ? "Unavailable"
                                          : "…"}
                                </span>
                            </div>

                            <div className="account-menu-actions">
                                {hasExtension && source !== "extension" && (
                                    <button
                                        type="button"
                                        className="account-menu-action"
                                        disabled={busy}
                                        onClick={() => run(connectExtension)}
                                    >
                                        Switch to wallet
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="account-menu-action"
                                    onClick={() => {
                                        disconnect();
                                        setOpen(false);
                                    }}
                                >
                                    Sign out
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="account-menu-prompt">
                                <span className="account-menu-prompt-title">
                                    Connect your account
                                </span>
                                <span className="account-menu-prompt-sub">
                                    Sign in to deploy and manage your sites.
                                </span>
                            </div>
                            {hostSignedOut && (
                                <button
                                    type="button"
                                    className="account-menu-action is-primary"
                                    disabled={busy}
                                    onClick={() => run(signInHost)}
                                >
                                    Sign in to Polkadot
                                </button>
                            )}
                            {hasExtension && (
                                <button
                                    type="button"
                                    className="account-menu-action is-primary"
                                    disabled={busy}
                                    onClick={() => run(connectExtension)}
                                >
                                    Connect wallet
                                </button>
                            )}
                            {!hasExtension && !hostSignedOut && (
                                <div className="account-menu-empty">
                                    No Polkadot wallet found.{" "}
                                    <a href={WALLET_URL} target="_blank" rel="noopener">
                                        Get a wallet ↗
                                    </a>
                                </div>
                            )}
                        </>
                    )}

                    {/* Dev account: a subtle local-testing fallback, available in
                        every state — demoted to a divided footer so it stays out
                        of the way of the real sign-in path. */}
                    <label className="account-dev-toggle">
                        <input
                            type="checkbox"
                            checked={usingDev}
                            onChange={(e) => setUseDev(e.target.checked)}
                        />
                        <span>Use dev account</span>
                    </label>

                    {error && <div className="account-menu-error">{error}</div>}
                </div>
            )}
        </div>
    );
}
