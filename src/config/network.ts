/**
 * Network configuration — the single source of truth for the Testnet ⇄ Mainnet toggle.
 *
 * The same Odra contracts are deployed to both Casper networks. Everything that differs
 * between them (RPC endpoint, CSPR.cloud base, block explorer, chain name, contract
 * addresses, real-money guardrails) lives here. Nothing else in the app should hardcode
 * a network-specific value.
 */

import { currentMaxBetCspr, UNAUDITED_MAINNET_CAP_CSPR } from "./caps";

export type CasperNetwork = "testnet" | "mainnet";

export const CASPER_NETWORKS: readonly CasperNetwork[] = ["testnet", "mainnet"] as const;

export interface ContractAddresses {
  /** MarketFactory — deploys/registers markets. */
  marketFactory?: string;
  /** OracleRegistry — oracle identity + reputation. */
  oracleRegistry?: string;
  /** ParimutuelVault — escrow + settlement. */
  vault?: string;
  /**
   * HunchVault v2 — the singleton multi-market vault (S16). Markets are state entries
   * keyed by slug; `bet`/`resolve` calls carry a `market_id` arg. When set, slugs not in
   * `marketAddresses` route here (cheap `create_market` calls, no per-market installs).
   */
  vaultV2?: string;
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
   * Per-market deployed `ParimutuelMarket` package hashes (slug → `hash-<64hex>`), from the
   * full-catalogue deploy manifest (`NEXT_PUBLIC_*_MARKET_ADDRS`, JSON). Markets not in the map
   * fall back to `contracts.vault` so a single-contract thin-slice deploy keeps working.
   */
  marketAddresses: Record<string, string>;
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

const CONTRACT_HASH = /^(hash-|contract-package-)?[0-9a-fA-F]{64}$/;

/**
 * Parse a `NEXT_PUBLIC_*_MARKET_ADDRS` value — a JSON object of catalogue slug → deployed
 * `ParimutuelMarket` package hash. Defensive: unset/malformed JSON or non-hash values yield an
 * empty/partial map rather than throwing (a bad ops env must never take the app down).
 */
export function parseMarketAddresses(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [slug, hash] of Object.entries(parsed)) {
    if (typeof hash === "string" && CONTRACT_HASH.test(hash)) out[slug] = hash;
  }
  return out;
}

export const NETWORKS: Record<CasperNetwork, NetworkConfig> = {
  testnet: {
    network: "testnet",
    label: "Testnet",
    chainName: "casper-test",
    nodeRpcUrl: env("NEXT_PUBLIC_CASPER_TESTNET_RPC", "https://node.testnet.casper.network/rpc"),
    csprCloudBaseUrl: env("NEXT_PUBLIC_CSPR_CLOUD_TESTNET", "https://api.testnet.cspr.cloud"),
    explorerBaseUrl: env("NEXT_PUBLIC_CASPER_TESTNET_EXPLORER", "https://testnet.cspr.live"),
    contracts: {
      marketFactory: envAddr("NEXT_PUBLIC_TESTNET_MARKET_FACTORY"),
      oracleRegistry: envAddr("NEXT_PUBLIC_TESTNET_ORACLE_REGISTRY"),
      vault: envAddr("NEXT_PUBLIC_TESTNET_VAULT"),
      vaultV2: envAddr("NEXT_PUBLIC_TESTNET_VAULT_V2"),
    },
    marketAddresses: parseMarketAddresses(process.env.NEXT_PUBLIC_TESTNET_MARKET_ADDRS),
    guardrails: { maxBetCspr: null, showUnauditedBanner: false },
  },
  mainnet: {
    network: "mainnet",
    label: "Mainnet",
    chainName: "casper",
    nodeRpcUrl: env("NEXT_PUBLIC_CASPER_MAINNET_RPC", "https://node.mainnet.casper.network/rpc"),
    csprCloudBaseUrl: env("NEXT_PUBLIC_CSPR_CLOUD_MAINNET", "https://api.cspr.cloud"),
    explorerBaseUrl: env("NEXT_PUBLIC_CASPER_MAINNET_EXPLORER", "https://cspr.live"),
    contracts: {
      marketFactory: envAddr("NEXT_PUBLIC_MAINNET_MARKET_FACTORY"),
      oracleRegistry: envAddr("NEXT_PUBLIC_MAINNET_ORACLE_REGISTRY"),
      vault: envAddr("NEXT_PUBLIC_MAINNET_VAULT"),
      vaultV2: envAddr("NEXT_PUBLIC_MAINNET_VAULT_V2"),
    },
    marketAddresses: parseMarketAddresses(process.env.NEXT_PUBLIC_MAINNET_MARKET_ADDRS),
    // The static unaudited ceiling; the *effective* cap is the audit-gated ramp in `caps.ts`, which
    // never exceeds this until the contracts are audited (see `maxBetCspr` below).
    guardrails: { maxBetCspr: UNAUDITED_MAINNET_CAP_CSPR, showUnauditedBanner: true },
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
 * The chainspec floor on a NATIVE CSPR transfer, in motes (2.5 CSPR).
 *
 * This is a hard consensus rule, not a policy of ours: `core.native_transfer_minimum_motes` in the
 * Casper 2.0 chainspec (read back from a live node via `info_get_chainspec`). A native transfer
 * below it is rejected by the node at submit time with `-32016 insufficient transfer amount` — the
 * transaction never executes and no money moves.
 *
 * It is a config-level fact rather than an adapter detail because it constrains *product*
 * decisions, not just plumbing: any agent stake settled over the x402 rail is a native transfer,
 * so a strategy that stakes less than this can never bet at all. Three of the four Prophets were
 * sized below it (1–2 CSPR) and silently sat out every real-mode round until this was discovered.
 */
export const NATIVE_TRANSFER_MINIMUM_MOTES = 2_500_000_000n;

/**
 * Per-bet cap in whole CSPR for a network, or `null` if uncapped. Delegates to the audit-gated
 * cap-ramp policy (`caps.ts`): with no audit env set this returns the static unaudited ceiling
 * (25 CSPR on mainnet, uncapped on testnet), so it is a superset of the old static behaviour.
 */
export function maxBetCspr(network: CasperNetwork): number | null {
  return currentMaxBetCspr(network);
}

/**
 * The single source of truth for the mainnet per-bet cap. Both the human bet route and the
 * agent x402 rail enforce it server-side, and the trade panel surfaces it client-side, so a bet
 * can never route around the guardrail on any surface. `amountCspr` is a whole-CSPR amount.
 */
export function exceedsBetCap(network: CasperNetwork, amountCspr: number): boolean {
  const cap = currentMaxBetCspr(network);
  return cap != null && amountCspr > cap;
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
