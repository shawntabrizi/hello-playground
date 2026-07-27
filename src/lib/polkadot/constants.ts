// All network endpoints and contract addresses come from /networks.json —
// the top-level config for the test networks this app can target. Switch
// networks by changing its `active` field; re-sync values from
// bulletin-deploy/assets/environments.json when backends change.

import networksConfig from "../../../networks.json";

export interface NetworkConfig {
    name: string;
    description: string;
    /** Product SDK preset for the Asset Hub client (getChainAPI). See CHAIN. */
    chain: string;
    bulletinRpc: string;
    /** Reference only — the SDK preset named by `chain` carries the endpoint the
     *  app actually dials. Kept so the entry documents which chain it describes
     *  and can be cross-checked against the preset's descriptor. */
    assetHubRpc: string;
    /** Reference only, as `assetHubRpc` — must match the `chain` preset's genesis. */
    assetHubGenesis?: string;
    ipfsGateway: string;
    dotHost: string;
    nativeToEthRatio: number;
    bulletinFaucetUrl: string;
    pasFaucetUrl: string;
    contracts: {
        registry: string;
        registrar: string;
        registrarController: string;
        contentResolver: string;
        popRules: string;
    };
}

const networks: Record<string, NetworkConfig> = networksConfig.networks;
export const NETWORK: NetworkConfig = networks[networksConfig.active];
if (!NETWORK) {
    throw new Error(
        `networks.json: active network "${networksConfig.active}" is not defined`,
    );
}

// Product SDK preset for getChainAPI(CHAIN) — this, NOT assetHubRpc, decides
// which chain the app connects to. getChainAPI takes only an environment name;
// it carries its own endpoints and descriptors and never reads networks.json.
// So the preset and this entry's contract addresses MUST describe the same
// chain — "paseo" is Paseo Next (Asset Hub 1500), "devnet" is the Products
// Devnet (Asset Hub 1000), and they are different networks with different
// contracts. Getting this wrong fails quietly: the app connects and loads, then
// every contract read comes back empty because those addresses live elsewhere.
//
// Only presets the SDK actually ships can be targeted. The SDK's Environment is
// polkadot | kusama | paseo | devnet; polkadot and kusama have no live Bulletin
// or Individuality chain, leaving these two for products.
const SUPPORTED_CHAINS = ["paseo", "devnet"] as const;
export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

function assertSupportedChain(chain: string): SupportedChain {
    if (!(SUPPORTED_CHAINS as readonly string[]).includes(chain)) {
        throw new Error(
            `networks.json: active network "${networksConfig.active}" sets chain preset "${chain}", which the Product SDK has no preset for (expected one of ${SUPPORTED_CHAINS.join(", ")}). The app would connect to a different chain than its contract addresses live on.`,
        );
    }
    return chain as SupportedChain;
}

export const CHAIN: SupportedChain = assertSupportedChain(NETWORK.chain);

export const BULLETIN_RPC = NETWORK.bulletinRpc;
export const BULLETIN_GATEWAY = `${NETWORK.ipfsGateway}/ipfs/`;

/** Host suffix where DotNS names resolve (e.g. `<name>.dev-dot.li`). */
export const DOT_HOST = NETWORK.dotHost;

/** DotNS deployed contract addresses on the active network's Asset Hub. */
export const DOTNS_CONTRACTS = NETWORK.contracts;

/** Native-token base units → EVM Wei (18 decimals) conversion factor. */
export const NATIVE_TO_ETH_RATIO = BigInt(NETWORK.nativeToEthRatio);

/** Self-serve faucet for Bulletin storage authorization. */
export const BULLETIN_FAUCET_URL = NETWORK.bulletinFaucetUrl;

/** Faucet for native tokens to pay contract fees on Asset Hub. */
export const PAS_FAUCET_URL = NETWORK.pasFaucetUrl;
