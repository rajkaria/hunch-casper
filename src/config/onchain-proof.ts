/**
 * On-chain proof — the receipts that make "it's real on Casper" checkable in one click. The
 * judged surface runs the deterministic mock economy (always alive, credential-free), while the
 * chain layer's reality is proven separately: the deployed contract package hashes (from the
 * network config env) and hand-picked transaction receipts (bets/resolutions minted during the
 * ops deploy, via `NEXT_PUBLIC_ONCHAIN_RECEIPTS`) render as real cspr.live links on the landing
 * page and docs. Nothing here is fabricated: with no env wired the proof is empty and the UI
 * hides the section entirely.
 *
 * `NEXT_PUBLIC_ONCHAIN_RECEIPTS` is a JSON array of `{ label, hash, network }` — e.g.
 * `[{"label":"First real bet (proxy-payable)","hash":"<64 hex>","network":"testnet"}]`.
 */

import type { CasperNetwork, NetworkConfig } from "@/config/network";
import { explorerTransactionUrl, getNetworkConfig, isCasperNetwork } from "@/config/network";

export interface ProofLink {
  label: string;
  hash: string;
  url: string;
}

export interface OnchainProof {
  network: CasperNetwork;
  /** Deployed contract packages (from `NEXT_PUBLIC_*_MARKET_FACTORY` / `_ORACLE_REGISTRY` / `_VAULT`). */
  contracts: ProofLink[];
  /** Individual transaction receipts (from `NEXT_PUBLIC_ONCHAIN_RECEIPTS`). */
  receipts: ProofLink[];
  hasAny: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** `hash-<64hex>` / `contract-package-<64hex>` / bare hex → 64-char hex, or null if malformed. */
function bareHash(address: string): string | null {
  const hex = address.replace(/^(hash-|contract-package-|contract-)/, "").toLowerCase();
  return HEX64.test(hex) ? hex : null;
}

/** cspr.live contract-package page for a deployed contract on a network. */
export function explorerContractPackageUrl(network: CasperNetwork, address: string): string | null {
  const hex = bareHash(address);
  return hex ? `${getNetworkConfig(network).explorerBaseUrl}/contract-package/${hex}` : null;
}

const CONTRACT_LABELS: readonly [keyof NetworkConfig["contracts"], string][] = [
  ["marketFactory", "MarketFactory"],
  ["oracleRegistry", "OracleRegistry"],
  ["vault", "ParimutuelMarket (vault)"],
];

/** Parse `NEXT_PUBLIC_ONCHAIN_RECEIPTS` for one network; malformed JSON/entries are dropped. */
export function parseReceipts(network: CasperNetwork): ProofLink[] {
  const raw = process.env.NEXT_PUBLIC_ONCHAIN_RECEIPTS;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ProofLink[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { label, hash, network: net } = entry as Record<string, unknown>;
    if (typeof label !== "string" || typeof hash !== "string") continue;
    if (!isCasperNetwork(net) || net !== network) continue;
    if (!HEX64.test(hash.toLowerCase())) continue;
    out.push({ label, hash, url: explorerTransactionUrl(network, hash) });
  }
  return out;
}

/** The full proof for a network. `cfg` is injectable for tests (env is read at module load). */
export function onchainProof(network: CasperNetwork, cfg: NetworkConfig = getNetworkConfig(network)): OnchainProof {
  const contracts: ProofLink[] = [];
  for (const [key, label] of CONTRACT_LABELS) {
    const address = cfg.contracts[key];
    if (!address) continue;
    const url = explorerContractPackageUrl(network, address);
    if (url) contracts.push({ label, hash: address, url });
  }
  // Per-market ParimutuelMarket packages from the catalogue deploy (NEXT_PUBLIC_*_MARKET_ADDRS).
  for (const slug of Object.keys(cfg.marketAddresses).sort()) {
    const address = cfg.marketAddresses[slug];
    const url = explorerContractPackageUrl(network, address);
    if (url) contracts.push({ label: `ParimutuelMarket — ${slug}`, hash: address, url });
  }
  const receipts = parseReceipts(network);
  return { network, contracts, receipts, hasAny: contracts.length > 0 || receipts.length > 0 };
}
