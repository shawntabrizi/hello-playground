// Pre-flight checks for the deploy flow. Everything here is read-only —
// storage queries and pallet-revive dry-runs — so the checklist can run
// automatically (and repeatedly) at zero cost before the user commits to
// the irreversible deploy transactions.
//
// Severity model: "fail" blocks the Deploy button (deploying WOULD fail or
// waste a transaction), "warn" does not (we couldn't verify, or deploy can
// recover — e.g. the one-time map_account setup). A flaky RPC must never
// lock the user out of deploying: checks that throw degrade to "warn" and
// the deploy path re-verifies everything authoritatively anyway.

import type { ActiveAccount } from "./account.ts";
import { computeCID } from "./lib/bulletin/cid.ts";
import { checkBulletinAuthorization, MAX_TX_BYTES } from "./lib/bulletin/store.ts";
import { getEvmAddress } from "./lib/dotns/address.ts";
import { isAccountMapped } from "./lib/dotns/contracts.ts";
import { checkDomainAvailability, getDomainOwner, quoteDomain } from "./lib/dotns/register.ts";
import { getAssetHubClient } from "./lib/polkadot/clients.ts";
import {
    BULLETIN_FAUCET_URL,
    BULLETIN_GATEWAY,
    DOT_HOST,
    NATIVE_TO_ETH_RATIO,
    PAS_FAUCET_URL,
} from "./lib/polkadot/constants.ts";
import { formatNative, getNativeUnit } from "./lib/polkadot/native.ts";

export type CheckState = "ok" | "warn" | "fail";

/** Append `address=<acct>` to a faucet URL, preserving any existing query
 *  (the PAS faucet already carries `?parachain=<id>`), so "faucet" lands on a
 *  form pre-filled for the account that needs funding. */
export function withAddress(url: string, address: string): string {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}address=${encodeURIComponent(address)}`;
}

export interface PreflightCheck {
    id: "size" | "bulletin" | "name" | "funds" | "mapped";
    label: string;
    state: CheckState;
    /** Plain-English status, always shown. */
    detail: string | null;
    /** Developer-facing raw values (bytes, balances, tiers) — shown only when
     *  the user toggles "Developer details". */
    tech: string | null;
    /** Actionable link (faucet etc.) rendered next to the detail. */
    link: string | null;
}

export interface PreflightReport {
    checks: PreflightCheck[];
    /** True when nothing is "fail" — warns don't block the Deploy button. */
    ok: boolean;
    bytes: number;
    cid: string;
    label: string;
    url: string;
    gatewayUrl: string;
    /** Registration price in native units, when the quote succeeded. */
    priceNative: bigint | null;
}

// Rough headroom for fees + the two contract storage deposits, in whole PAS.
// Deliberately coarse — exact estimation needs per-tx query_info and isn't
// worth it. Scaled by the chain's actual unit at use, NOT by a hardcoded one:
// this was 5n * 10n**12n against a 10-decimal chain, i.e. a 500 PAS threshold
// masquerading as 5.
const FEE_MARGIN_PAS = 5n;

/** Client-side label rules — same shape the chain-side PoP rules expect. */
export function validateLabel(label: string): string | null {
    if (!label) return "Name is empty";
    if (!/^[a-z0-9-]+$/.test(label))
        return "Use lowercase letters, digits, and hyphens only";
    if (label.startsWith("-") || label.endsWith("-"))
        return "Can't start or end with a hyphen";
    if (label.length < 3) return "Must be at least 3 characters";
    if (label.length > 63) return "Must be at most 63 characters";
    return null;
}

const verifyLater = (id: PreflightCheck["id"], label: string): PreflightCheck => ({
    id,
    label,
    state: "warn",
    detail: "Couldn't check — the deploy will verify this.",
    tech: "Check timed out or the RPC errored (read-only — deploy re-verifies).",
    link: null,
});

// Each chain check catches its own errors, but a hung RPC connection never
// rejects — it just stays pending, pinning the UI on "checking…" forever.
// Racing against a deadline makes the report total: worst case is a row of
// "couldn't verify" warns, and the checklist is advisory anyway (deploy
// re-verifies everything on-chain).
const CHECK_TIMEOUT_MS = 5_000;

const guarded = (
    id: PreflightCheck["id"],
    label: string,
    check: () => Promise<PreflightCheck>,
): Promise<PreflightCheck> =>
    Promise.race([
        check().catch(() => verifyLater(id, label)),
        new Promise<PreflightCheck>((resolve) =>
            setTimeout(() => resolve(verifyLater(id, label)), CHECK_TIMEOUT_MS),
        ),
    ]);

export async function runPreflight(params: {
    html: string;
    label: string;
    account: ActiveAccount;
}): Promise<PreflightReport> {
    const { html, label, account } = params;

    // Every PAS figure below is scaled by the chain's own decimals. Started
    // here (not awaited) so the local checks don't queue behind the chain read;
    // each check awaits it only when it has a number to render.
    const unitPromise = getNativeUnit();
    // Observe it immediately: the checks below can each return before ever
    // awaiting it (an invalid label short-circuits, a zero balance short
    // -circuits), and an unobserved rejection surfaces as a console error.
    unitPromise.catch(() => {});

    const bytes = new TextEncoder().encode(html);
    const cid = computeCID(bytes).toString();

    // ── size: local, exact ───────────────────────────────────────────────
    const sizeOk = bytes.length <= MAX_TX_BYTES;
    const sizeCheck: PreflightCheck = {
        id: "size",
        label: "Site size",
        state: sizeOk ? "ok" : "fail",
        detail: sizeOk ? "Ready" : "Too large to deploy — remove large files or images",
        tech: `${bytes.length.toLocaleString()} B / ${(MAX_TX_BYTES / 1024 / 1024).toFixed(0)} MiB max`,
        link: null,
    };

    // ── bulletin: host accounts store via the host's preimage channel (no
    //    authorization, no Bulletin RPC). For direct routes a non-expired
    //    authorization is the actual store gate; the byte allowance is a
    //    soft priority signal (warn, never fail) ──────────────────────────
    const bulletinCheck = async (): Promise<PreflightCheck> => {
        if (account.source === "host") {
            return {
                id: "bulletin",
                label: "Bulletin storage",
                state: "ok",
                detail: "Ready",
                tech: "Host account — submitted by the host, no authorization needed",
                link: null,
            };
        }
        const auth = await checkBulletinAuthorization(account.address);
        if (!auth.authorized) {
            return {
                id: "bulletin",
                label: "Bulletin storage",
                state: "fail",
                detail: "You need storage access to deploy.",
                tech: auth.expired
                    ? `Authorization expired at block #${auth.expiresAt?.toLocaleString()}`
                    : `${account.displayName} has no Bulletin storage authorization`,
                link: BULLETIN_FAUCET_URL,
            };
        }
        const remaining = auth.bytesAllowance - auth.bytesUsed;
        if (remaining < BigInt(bytes.length)) {
            return {
                id: "bulletin",
                label: "Bulletin storage",
                state: "warn",
                detail: "Storage may be low — the deploy still works, at lower priority.",
                tech: `${(remaining > 0n ? remaining : 0n).toLocaleString()} B of ${auth.bytesAllowance.toLocaleString()} B allowance left for a ${bytes.length.toLocaleString()} B site`,
                link: BULLETIN_FAUCET_URL,
            };
        }
        return {
            id: "bulletin",
            label: "Bulletin storage",
            state: "ok",
            detail: "Ready",
            tech: `${remaining.toLocaleString()} B of ${auth.bytesAllowance.toLocaleString()} B allowance remaining`,
            link: null,
        };
    };

    // ── name: local validity → availability → PoP quote ─────────────────
    let priceNative: bigint | null = null;
    const nameCheck = async (): Promise<PreflightCheck> => {
        const invalid = validateLabel(label);
        if (invalid) {
            return { id: "name", label: ".dot name", state: "fail", detail: invalid, tech: `validateLabel: ${invalid}`, link: null };
        }
        const ownerEvm = await getEvmAddress(account.address);
        const available = await checkDomainAvailability(label, account.address);
        if (!available) {
            const owner = await getDomainOwner(label, account.address);
            if (owner && owner.toLowerCase() === ownerEvm.toLowerCase()) {
                return {
                    id: "name",
                    label: ".dot name",
                    state: "ok",
                    detail: "Yours — deploying updates it",
                    tech: `${label}.dot owned by this account — content update, no registration fee`,
                    link: null,
                };
            }
            return {
                id: "name",
                label: ".dot name",
                state: "fail",
                detail: "Taken — pick another name",
                tech: `${label}.dot already registered to ${owner ?? "another account"}`,
                link: null,
            };
        }
        const quote = await quoteDomain(label, ownerEvm, account.address);
        if (quote.price !== null) priceNative = quote.price / NATIVE_TO_ETH_RATIO;
        const priceText =
            priceNative !== null ? ` · price ${formatNative(priceNative, await unitPromise)}` : "";
        // The message is a classification, present even on success
        // ("Available to all"). The actual verdict is the tier comparison:
        // the account can register iff userStatus >= status.
        if (
            quote.status !== null &&
            quote.userStatus !== null &&
            quote.userStatus < quote.status
        ) {
            return {
                id: "name",
                label: ".dot name",
                state: "warn",
                detail: `Available, but restricted${quote.message ? ` ("${quote.message}")` : ""} — try a longer name ending in two digits.`,
                tech: `requires tier ${quote.status}, your PoP tier ${quote.userStatus}${priceText}`,
                link: null,
            };
        }
        return {
            id: "name",
            label: ".dot name",
            state: "ok",
            detail: "Available",
            tech: `available${priceText}${quote.status !== null ? `, name tier ${quote.status}` : ""}`,
            link: null,
        };
    };

    // ── funds: host allowance, or on-chain balance for extension/dev ────
    let freeNative: bigint | null = null;
    const fundsCheck = async (): Promise<PreflightCheck> => {
        // Host-mediated transactions are FEE-sponsored (AsPgas), but the
        // domain price and pallet-revive storage deposits are value
        // transfers from the account's own balance — empirically the host
        // does NOT cover those (register dispatches Revive::TransferFailed
        // on an unfunded product account). So every source needs a balance;
        // only the wording differs.
        const { api } = await getAssetHubClient();
        const info = await api.query.System.Account.getValue(account.address);
        freeNative = info.data.free;
        if (freeNative === 0n) {
            return {
                id: "funds",
                label: "Funds",
                state: "fail",
                detail: "Test tokens are needed to register your .dot name.",
                tech: `0 PAS free on Asset Hub${account.source === "host" ? " (fees host-sponsored, but the domain price + deposits aren't)" : ""}`,
                link: withAddress(PAS_FAUCET_URL, account.address),
            };
        }
        return {
            id: "funds",
            label: "Funds",
            state: "ok",
            detail: "Ready",
            tech: `${formatNative(freeNative, await unitPromise)} free on Asset Hub${account.source === "host" ? " (fees host-sponsored)" : ""}`,
            link: null,
        };
    };

    // ── mapped: read-only revive probe ───────────────────────────────────
    const mappedCheck = async (): Promise<PreflightCheck> => {
        const mapped = await isAccountMapped(account.address);
        return mapped
            ? { id: "mapped", label: "Account setup", state: "ok", detail: "Ready", tech: "Mapped on Asset Hub", link: null }
            : {
                  id: "mapped",
                  label: "Account setup",
                  state: "warn",
                  detail: "A one-time setup step runs during deploy.",
                  tech: "Not mapped — map_account runs as the first deploy tx",
                  link: null,
              };
    };

    const [bulletin, name, funds, mapped] = await Promise.all([
        guarded("bulletin", "Bulletin storage", bulletinCheck),
        guarded("name", ".dot name", nameCheck),
        guarded("funds", "Funds", fundsCheck),
        guarded("mapped", "Account setup", mappedCheck),
    ]);

    // Cross-check once both sides are known: balance vs price + headroom
    // (deposits dominate the margin; host fee sponsorship doesn't change it
    // much since fees are the smallest component). A unit we couldn't read
    // means we can't compare — leave the funds verdict as the balance read
    // found it rather than inventing a threshold.
    const unit = await unitPromise.catch(() => null);
    if (
        funds.state === "ok" &&
        priceNative !== null &&
        freeNative !== null &&
        unit !== null &&
        freeNative < priceNative + FEE_MARGIN_PAS * unit
    ) {
        funds.state = "warn";
        funds.detail = "You're close — top up to cover the registration fees.";
        funds.tech = `${formatNative(freeNative, unit)} free vs price ${formatNative(priceNative, unit)} + ~${formatNative(FEE_MARGIN_PAS * unit, unit)} fees/deposits`;
        funds.link = withAddress(PAS_FAUCET_URL, account.address);
    }

    const checks = [sizeCheck, bulletin, name, funds, mapped];
    return {
        checks,
        ok: checks.every((c) => c.state !== "fail"),
        bytes: bytes.length,
        cid,
        label,
        url: `https://${label}.${DOT_HOST}`,
        gatewayUrl: `${BULLETIN_GATEWAY}${cid}`,
        priceNative,
    };
}
