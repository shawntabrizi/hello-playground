// Chain clients for Asset Hub Next and Bulletin.
//
// Asset Hub goes through the Product SDK's getChainAPI(CHAIN): one client that
// serves the host (Polkadot Desktop/Mobile) and standalone/extension alike,
// with runtime-matched built-in descriptors. ReviveApi dry-runs run on the
// UNSAFE api on purpose — unsafe calls bypass descriptor-compatibility checks,
// so descriptor drift against the live runtime can't brick the read path. Only
// `assetHub.tx.*` is typed.
//
// Bulletin uploads now go through @parity/product-sdk-cloud-storage
// (see lib/bulletin/store.ts) — no direct Bulletin WS client lives here.

import {
    getChainAPI,
    type ChainClient as SdkChainClient,
    type PresetChains,
} from "@parity/product-sdk-chain-client";
import { READ_DEADLINE_MS, withDeadline } from "../deadline.ts";
import { CHAIN } from "./constants.ts";

// Pin to the paseo preset so the typed Asset Hub api is concrete (System,
// Revive, …) rather than a union across all four preset chains — the union
// widens field types (e.g. account balances to `bigint | null`). CHAIN is the
// literal "paseo", so getChainAPI(CHAIN) returns exactly this client shape.
type ChainClient = SdkChainClient<PresetChains<"paseo">>;

export interface AssetHubHandle {
    api: ChainClient["assetHub"];
    unsafeApi: ReturnType<ChainClient["raw"]["assetHub"]["getUnsafeApi"]>;
}

let assetHubHandle: Promise<AssetHubHandle> | null = null;

// Memoized but SELF-HEALING: `??=` caches a promise, so a rejected/timed-out
// connect would otherwise be cached as a permanently-rejected promise — every
// later caller re-awaits the same failure. The .catch nulls the slot so the
// next call genuinely reconnects, and withDeadline converts a HANGING connect
// (the host transport's typical failure mode) into a rejection instead of a
// forever-pending promise.
export function getAssetHubClient(): Promise<AssetHubHandle> {
    if (!assetHubHandle) {
        assetHubHandle = withDeadline(getChainAPI(CHAIN), READ_DEADLINE_MS, "Asset Hub connection")
            .then((client) => ({
                api: client.assetHub,
                unsafeApi: client.raw.assetHub.getUnsafeApi(),
            }))
            .catch((cause) => {
                assetHubHandle = null;
                throw cause;
            });
    }
    return assetHubHandle;
}

/** Drop the memoized handle so the next getAssetHubClient() reconnects — a
 *  long-lived socket can wedge (e.g. after the webview is backgrounded). */
export function resetAssetHubClient(): void {
    assetHubHandle = null;
}
