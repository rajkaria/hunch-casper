/**
 * Deploy manifest — the exact, credential-free description of everything a network needs
 * stood up on-chain: the two singleton infrastructure contracts (`MarketFactory` registry +
 * `OracleRegistry`) and one `ParimutuelMarket` per catalogue market, each with its init +
 * register args and house seed liquidity (from `buildAllDeployPlans`).
 *
 * This is the S11 "deploy all contracts + the full catalogue to mainnet" made concrete: the
 * `MarketDeployPlan`s are network-agnostic (address-free), so the SAME manifest deploys to
 * testnet and mainnet — the identity that lets one codebase serve both networks behind the
 * toggle. What differs per network is only the deploy target (chain name, RPC, explorer) and
 * the real-money guardrails, which are carried alongside for the operator/runbook.
 *
 * A deploy driver (the Odra `contracts/bin/cli.rs` livenet CLI, or an operator script) iterates
 * `markets` to deploy + register every market; `GET /api/deploy-plan?network=` serves this so the
 * catalogue is always the single source of truth for what is on-chain.
 */

import type { CasperNetwork, ContractAddresses, NetworkConfig } from "@/config/network";
import { getNetworkConfig } from "@/config/network";
import { buildAllDeployPlans, type MarketDeployPlan } from "@/core/market-generator";

/** A singleton infra contract deployed once per network. */
export interface InfrastructureContract {
  contract: "MarketFactory" | "OracleRegistry";
  role: string;
}

export interface DeployManifest {
  network: CasperNetwork;
  /** Casper chain name used when signing the deploy transactions. */
  chainName: NetworkConfig["chainName"];
  nodeRpcUrl: string;
  explorerBaseUrl: string;
  /** Already-deployed addresses injected via `NEXT_PUBLIC_*` (undefined until a deploy lands). */
  contracts: ContractAddresses;
  /** Real-money guardrails in force on this network (mainnet: capped + disclosed). */
  guardrails: NetworkConfig["guardrails"];
  /** The two singleton contracts to deploy once, before any market. */
  infrastructure: InfrastructureContract[];
  /** One `ParimutuelMarket` per catalogue market — init + register args + seed liquidity. */
  markets: MarketDeployPlan[];
  /** Convenience count for the runbook + preflight. */
  marketCount: number;
}

/**
 * Build the full deploy manifest for a network. Pure + address-free: `markets` is identical
 * across networks (same contracts, both networks); only the deploy target + guardrails differ.
 */
export function buildDeployManifest(network: CasperNetwork): DeployManifest {
  const cfg = getNetworkConfig(network);
  const markets = buildAllDeployPlans();
  return {
    network,
    chainName: cfg.chainName,
    nodeRpcUrl: cfg.nodeRpcUrl,
    explorerBaseUrl: cfg.explorerBaseUrl,
    contracts: cfg.contracts,
    guardrails: cfg.guardrails,
    infrastructure: [
      { contract: "MarketFactory", role: "on-chain registry of markets" },
      { contract: "OracleRegistry", role: "oracle identity + staked reputation" },
    ],
    markets,
    marketCount: markets.length,
  };
}
