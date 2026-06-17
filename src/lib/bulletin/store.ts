// Bulletin storage via @parity/product-sdk-cloud-storage, two routes:
//
// HOST (`viaHost`): the host submits the bytes as a preimage
// (`getPreimageManager().submit` + RFC-0002 PreimageSubmit permission) — no
// Bulletin RPC connection, no account authorization, no signing-channel size
// negotiation. No block info comes back; the client-side CID is the receipt.
//
// DIRECT (extension///Bob): CloudStorageClient.store signs an authorized
// TransactionStorage.store and waits for inclusion. The authorization check is
// a pre-flight nicety — unauthorized stores fail on Bulletin Chain.
//
// The client is owned here (not the chain-client singleton) because the builder
// supports the dev/extension accounts too: a lazy signer resolves whatever
// account the caller passes per store. Stores within one upload are sequential,
// so the single signer slot is race-free in practice.

import {
    ChunkStatus,
    CloudStorageClient,
    TxStatus,
    createLazySigner,
    type ProgressEvent,
} from "@parity/product-sdk-cloud-storage";
import { getPreimageManager } from "@parity/product-sdk-host";
import type { PolkadotSigner } from "polkadot-api";
import { ensureHostPermission } from "../host/permissions.ts";
import { READ_DEADLINE_MS, SUBMIT_DEADLINE_MS, withDeadline } from "../deadline.ts";
import { BULLETIN_FAUCET_URL, BULLETIN_GATEWAY, CHAIN } from "../polkadot/constants.ts";
import { computeCID } from "./cid.ts";
import type { DeployStatus } from "./submit-and-wait.ts";

import { MAX_TX_BYTES } from "./limits.ts";

export { MAX_TX_BYTES };
const MAX_SIZE = MAX_TX_BYTES;

export interface StoreHTMLResult {
    cid: string;
    /** Null on the host preimage route — the host doesn't report inclusion. */
    blockNumber: number | null;
    blockHash: string | null;
    ipfsUrl: string;
    bytes: number;
}

export interface AuthCheck {
    /** Entry exists and hasn't expired — the actual gate for `store`. */
    authorized: boolean;
    /** True when an entry exists but its window has lapsed. */
    expired: boolean;
    expiresAt: number | null;
    /** Soft-side consumption (store + renew) — priority signal, never gates. */
    bytesUsed: bigint;
    bytesAllowance: bigint;
    transactionsUsed: number;
    transactionsAllowance: number;
}

const NO_AUTH: AuthCheck = {
    authorized: false,
    expired: false,
    expiresAt: null,
    bytesUsed: 0n,
    bytesAllowance: 0n,
    transactionsUsed: 0,
    transactionsAllowance: 0,
};

// The lazy signer resolves the account of the in-flight store. Only one account
// is ever active at a time and stores within one upload are sequential, so a
// single slot is race-free in practice.
let currentSigner: PolkadotSigner | null = null;

let clientPromise: Promise<CloudStorageClient> | null = null;
function getBulletinClient(): Promise<CloudStorageClient> {
    // Self-healing singleton: caches the create() PROMISE, so a rejected or
    // timed-out create would otherwise be reused forever. Null the slot on
    // failure so the next caller rebuilds (mirrors clients.ts getAssetHubClient).
    if (!clientPromise) {
        clientPromise = withDeadline(
            CloudStorageClient.create({
                environment: CHAIN,
                signer: createLazySigner(
                    () => currentSigner,
                    "Bulletin store called with no active account signer",
                ),
            }),
            READ_DEADLINE_MS,
            "Bulletin client connection",
        ).catch((cause) => {
            clientPromise = null;
            throw cause;
        });
    }
    return clientPromise;
}

// Map the SDK's progress events onto the DeployStatus vocabulary the UI uses.
function statusFor(event: ProgressEvent): DeployStatus | null {
    switch (event.type) {
        case TxStatus.Signed:
            return "signing";
        case TxStatus.Broadcasted:
            return "broadcasting";
        case TxStatus.InBlock:
            return "in-block";
        case TxStatus.Finalized:
            return "finalized";
        default:
            return null; // chunk events handled separately
    }
}

export async function checkBulletinAuthorization(address: string): Promise<AuthCheck> {
    const client = await getBulletinClient();
    const status = await client.checkAuthorization(address);
    if (!status.authorized && status.expiration === 0) return NO_AUTH;
    // The SDK reports REMAINING quota (not allowance + used), so model the
    // richer shape as "allowance = remaining, used = 0" — the consumers compute
    // `bytesAllowance - bytesUsed` for the remaining budget, which stays exact.
    // `expired` is inferred: an entry with a non-zero expiration block that the
    // chain no longer treats as authorized has lapsed.
    return {
        authorized: status.authorized,
        expired: !status.authorized && status.expiration > 0,
        expiresAt: status.expiration > 0 ? status.expiration : null,
        bytesUsed: 0n,
        bytesAllowance: status.remainingBytes,
        transactionsUsed: 0,
        transactionsAllowance: status.remainingTransactions,
    };
}

export async function storeBytes(params: {
    bytes: Uint8Array;
    signer: PolkadotSigner;
    signerAddress: string;
    displayName: string;
    label?: string;
    /** Route through the host's preimage submission (host accounts). */
    viaHost?: boolean;
    onStatus?: (status: DeployStatus | string) => void;
}): Promise<StoreHTMLResult> {
    const { bytes, signer, signerAddress, displayName, label = "Content", viaHost, onStatus } =
        params;

    if (bytes.length === 0) throw new Error(`${label} is empty — nothing to store`);
    if (bytes.length > MAX_SIZE) {
        throw new Error(
            `${label} is ${bytes.length.toLocaleString()} bytes — Bulletin max is ${MAX_SIZE.toLocaleString()} (~2 MiB)`,
        );
    }

    if (viaHost) {
        // Status tags map onto the same stages the direct route reports:
        // permission prompt ≈ signing, host submission ≈ broadcast.
        onStatus?.("signing");
        await ensureHostPermission("PreimageSubmit");
        const manager = await getPreimageManager();
        if (!manager) {
            throw new Error(
                "Host preimage API unavailable — cannot store via the host on this platform",
            );
        }
        const cid = computeCID(bytes);
        onStatus?.("broadcasting");
        const key = await withDeadline(
            manager.submit(bytes),
            SUBMIT_DEADLINE_MS,
            "Saving your site to Bulletin",
        );
        // The returned key is the preimage hash. When it's a comparable 32-byte
        // hex, verify it matches our blake2b-256 digest — a mismatch means the
        // host stored (or hashed) something other than what we sent, and the
        // gateway URL we'd report would 404. Unrecognized key formats pass
        // through: a host-side format change must not start failing every upload.
        const digestHex = `0x${Array.from(cid.multihash.digest, (b) =>
            b.toString(16).padStart(2, "0"),
        ).join("")}`;
        if (/^0x[0-9a-f]{64}$/i.test(key) && key.toLowerCase() !== digestHex) {
            throw new Error(
                `Host preimage key ${key} doesn't match the expected blake2b-256 ` +
                    `digest ${digestHex} — the stored bytes may differ from what was sent`,
            );
        }
        onStatus?.("finalized");
        return {
            cid: cid.toString(),
            blockNumber: null,
            blockHash: null,
            ipfsUrl: `${BULLETIN_GATEWAY}${cid.toString()}`,
            bytes: bytes.length,
        };
    }

    const auth = await checkBulletinAuthorization(signerAddress);
    if (!auth.authorized) {
        throw new Error(
            auth.expired
                ? `Bulletin authorization for ${displayName} expired at block #${auth.expiresAt?.toLocaleString()}.\n\n` +
                  `Re-up at the self-serve faucet:\n${BULLETIN_FAUCET_URL}`
                : `No Bulletin authorization for ${displayName} (${signerAddress}).\n\n` +
                  `Self-serve faucet:\n${BULLETIN_FAUCET_URL}`,
        );
    }
    // No byte-budget throw: the soft-side counters never gate a store call —
    // consumption past the allowance only degrades priority.

    const client = await getBulletinClient();
    currentSigner = signer;
    try {
        onStatus?.("signing");
        // Deadline-bound: a stalled Bulletin node hangs rather than rejects,
        // which would otherwise pin the spinner open forever. Retrying is safe —
        // Bulletin dedupes by content.
        const result = await withDeadline(
            client
                .store(bytes)
                .withWaitFor("in_block")
                .withCallback((event) => {
                    if (event.type === ChunkStatus.ChunkStarted) {
                        onStatus?.(`signing chunk ${event.index + 1}/${event.total}`);
                        return;
                    }
                    const status = statusFor(event);
                    if (status) onStatus?.(status);
                })
                .send(),
            SUBMIT_DEADLINE_MS,
            "The Bulletin store",
        );

        // Use the RECEIPT's CID, never a locally computed one: for content above
        // one chunk it's the DAG-PB manifest CID, which a raw-codec CID computed
        // over the input bytes would not match.
        if (!result.cid) {
            throw new Error(
                `${label} stored but the receipt carries no CID — cannot build a gateway URL`,
            );
        }
        return {
            cid: result.cid.toString(),
            blockNumber: result.blockNumber ?? null,
            blockHash: null,
            ipfsUrl: `${BULLETIN_GATEWAY}${result.cid.toString()}`,
            bytes: result.size,
        };
    } finally {
        currentSigner = null;
    }
}

export async function storeHTML(params: {
    html: string;
    signer: PolkadotSigner;
    signerAddress: string;
    displayName: string;
    viaHost?: boolean;
    onStatus?: (status: DeployStatus | string) => void;
}): Promise<StoreHTMLResult> {
    return storeBytes({
        bytes: new TextEncoder().encode(params.html),
        signer: params.signer,
        signerAddress: params.signerAddress,
        displayName: params.displayName,
        label: "HTML",
        viaHost: params.viaHost,
        onStatus: params.onStatus,
    });
}
