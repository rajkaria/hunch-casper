/**
 * Network configuration — the single source of truth for the Testnet ⇄ Mainnet toggle.
 *
 * The same Odra contracts are deployed to both Casper networks. Everything that differs
 * between them (RPC endpoint, CSPR.cloud base, block explorer, chain name, contract
 * addresses, real-money guardrails) lives here. Nothing else in the app should hardcode
 * a network-specific value.
 */

export type CasperNetwork = "testnet" | "mainnet";

export const CASPER_NETWORKS: readonly CasperNetwork[] = ["testnet", "mainnet"] as const;

export interface ContractAddresses {
  /** MarketFactory — deploys/registers markets. */
  marketFactory?: string;
  /** OracleRegistry — oracle identity + reputation. */
  oracleRegistry?: string;
  /** ParimutuelVault — escrow + settlement. */
  vault?: string;
}

export interface NetworkConfig {
  network: CasperNetwork;
  /** Human label for the toggle. */
  label: string;
  /** Casper chain name used when signing deploys. */
  chainName: "casper-test" | "casper";
  /** JSON-RPC node endpoint. */
  nodeRpcUrl: string;
  /** CSPR.cloud middleware base URL (chain data feeds). */
  csprCloudBaseUrl: string;
  /** cspr.live block explorer base (no trailing slash). */
  explorerBaseUrl: string;
  /** Deployed contract addresses (populated as sprints land them on-chain). */
  contracts: ContractAddresses;
  /**
   * Real-money guardrails. Mainnet holds the full catalogue too, but bets are capped and
   * the UI carries an "unaudited hackathon build" disclosure. Testnet is unconstrained.
   */
  guardrails: {
    /** Max bet in CSPR. `null` = uncapped (testnet). */
    maxBetCspr: number | null;
    /** Show the unaudited-contracts disclosure banner. */
    showUnauditedBanner: boolean;
  };
}

/**
 * Env override helper — lets deploys inject real endpoints/addresses without code changes.
 * Falls back to the sensible public default.
 */
function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

function envAddr(key: string): string | undefined {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
}

export const NETWORKS: Record<CasperNetwork, NetworkConfig> = {
  testnet: {
    network: "testnet",
    label: "Testnet",
    chainName: "casper-test",
    nodeRpcUrl: env("NEXT_PUBLIC_CASPER_TESTNET_RPC", "https://rpc.testnet.casperlabs.io/rpc"),
    csprCloudBaseUrl: env("NEXT_PUBLIC_CSPR_CLOUD_TESTNET", "https://api.testnet.cspr.cloud"),
    explorerBaseUrl: env("NEXT_PUBLIC_CASPER_TESTNET_EXPLORER", "https://testnet.cspr.live"),
    contracts: {
      marketFactory: envAddr("NEXT_PUBLIC_TESTNET_MARKET_FACTORY"),
      oracleRegistry: envAddr("NEXT_PUBLIC_TESTNET_ORACLE_REGISTRY"),
      vault: envAddr("NEXT_PUBLIC_TESTNET_VAULT"),
    },
    guardrails: { maxBetCspr: null, showUnauditedBanner: false },
  },
  mainnet: {
    network: "mainnet",
    label: "Mainnet",
    chainName: "casper",
    nodeRpcUrl: env("NEXT_PUBLIC_CASPER_MAINNET_RPC", "https://rpc.mainnet.casperlabs.io/rpc"),
    csprCloudBaseUrl: env("NEXT_PUBLIC_CSPR_CLOUD_MAINNET", "https://api.cspr.cloud"),
    explorerBaseUrl: env("NEXT_PUBLIC_CASPER_MAINNET_EXPLORER", "https://cspr.live"),
    contracts: {
      marketFactory: envAddr("NEXT_PUBLIC_MAINNET_MARKET_FACTORY"),
      oracleRegistry: envAddr("NEXT_PUBLIC_MAINNET_ORACLE_REGISTRY"),
      vault: envAddr("NEXT_PUBLIC_MAINNET_VAULT"),
    },
    guardrails: { maxBetCspr: 25, showUnauditedBanner: true },
  },
};

export const DEFAULT_NETWORK: CasperNetwork =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK === "mainnet" ? "mainnet" : "testnet";

export function isCasperNetwork(value: unknown): value is CasperNetwork {
  return value === "testnet" || value === "mainnet";
}

export function getNetworkConfig(network: CasperNetwork): NetworkConfig {
  return NETWORKS[network];
}

/**
 * Explorer URL for a transaction hash on the given network. Casper 2.0 (Condor) serves
 * `TransactionV1` hashes — which the real adapter submits via `putTransaction` — under
 * `/transaction/<hash>` on cspr.live (legacy Deploys used `/deploy/`; we emit transactions).
 */
export function explorerTransactionUrl(network: CasperNetwork, transactionHash: string): string {
  return `${NETWORKS[network].explorerBaseUrl}/transaction/${transactionHash}`;
}

/** Explorer URL for an account hash / public key on the given network. */
export function explorerAccountUrl(network: CasperNetwork, account: string): string {
  return `${NETWORKS[network].explorerBaseUrl}/account/${account}`;
}
