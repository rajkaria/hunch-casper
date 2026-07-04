/**
 * CasperChainPort — the only surface `core/` uses to touch the chain.
 *
 * The mock adapter (deterministic, credential-free) satisfies this in tests and local dev.
 * The real Casper/Odra adapter lands behind the SAME interface in S1–S2, verified by the
 * shared contract tests — zero core refactor.
 */

import type { CasperNetwork } from "@/config/network";

export interface DeployResult {
  deployHash: string;
  explorerUrl: string;
}

export interface PlaceBetInput {
  marketId: string;
  outcomeKey: string;
  amountMotes: string;
  /** Bettor public key or `agent:<name>`. */
  bettor: string;
}

export interface ResolveMarketInput {
  marketId: string;
  winningOutcomeKey: string;
  /** Oracle identity performing the resolution. */
  oracleId: string;
}

export interface CasperChainPort {
  readonly network: CasperNetwork;
  /** Current block height — a cheap liveness probe. */
  getBlockHeight(): Promise<number>;
  /** Escrow a stake into the parimutuel vault. Returns the on-chain deploy. */
  placeBet(input: PlaceBetInput): Promise<DeployResult>;
  /** Post a resolution and trigger settlement. */
  resolveMarket(input: ResolveMarketInput): Promise<DeployResult>;
  explorerUrlForDeploy(deployHash: string): string;
}
