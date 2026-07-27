// Native-token (PAS) amounts: how many base units make one token, and how to
// render them.
//
// The decimal count is READ FROM THE CHAIN rather than hardcoded. It used to be
// a constant of 12 — inherited from a DotNS SDK reference — while both Paseo
// Next and the Products Devnet report 10. Every PAS figure in the app was
// therefore 100x off: balances rendered a hundred times too small, and the
// pre-flight funds threshold demanded a hundred times too much. Reading it from
// system_properties means a chain that disagrees can't silently skew the maths
// again.

import { getAssetHubClient } from "./clients.ts";

/** Decimals to assume if the chain doesn't report any. Both networks this app
 *  supports use 10; guessing beats bricking a deploy over a missing property,
 *  but it is logged because a wrong unit here is exactly the old bug. */
const FALLBACK_DECIMALS = 10;

function readDecimals(properties: unknown): number {
    // `ChainSpecData.properties` is typed `any` upstream, and tokenDecimals is
    // a bare number on some chains and a per-asset array on others.
    const value = (properties as { tokenDecimals?: unknown } | null)?.tokenDecimals;
    const candidate = Array.isArray(value) ? value[0] : value;
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
        return candidate;
    }
    console.warn(
        `[dotpages] chain reported no usable tokenDecimals (${JSON.stringify(value)}); assuming ${FALLBACK_DECIMALS}`,
    );
    return FALLBACK_DECIMALS;
}

let unitPromise: Promise<bigint> | null = null;

/** 10^decimals — the number of base units in one PAS. Memoized, and
 *  self-healing on failure like the clients it reads through. */
export function getNativeUnit(): Promise<bigint> {
    if (!unitPromise) {
        unitPromise = getAssetHubClient()
            .then(async ({ raw }) => {
                const spec = await raw.getChainSpecData();
                return 10n ** BigInt(readDecimals(spec.properties));
            })
            .catch((cause) => {
                unitPromise = null;
                throw cause;
            });
    }
    return unitPromise;
}

/** Render base units as PAS, trimming trailing zeros (`1.25 PAS`, `3 PAS`). */
export function formatNative(base: bigint, unit: bigint): string {
    const whole = base / unit;
    const frac = ((base % unit) * 10_000n) / unit;
    return frac === 0n
        ? `${whole} PAS`
        : `${whole}.${frac.toString().padStart(4, "0").replace(/0+$/, "")} PAS`;
}
