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

/**
 * A market created at RUNTIME as a state entry in the singleton `HunchVault` v2 — the S16 unlock
 * that made autonomous creation affordable (a few CSPR per `create_market` call, versus ~337 for
 * a per-market Wasm install). Genesis uses this; there is no v1 equivalent, because installing a
 * contract per idea was never something an agent could do on a schedule.
 */
export interface CreateMarketInput {
  /** The market's id inside the vault — the catalogue slug. */
  marketId: string;
  question: string;
  category: string;
  /**
   * The account allowed to resolve this market (`account-hash-…` or public key hex). It decides
   * who gets paid, which is why the vault refuses a creator who names themselves.
   */
  oracle: string;
  feeBps: number;
  /** Deadline as epoch ms — the vault stores block time in ms. */
  deadlineMs: number;
  /** Outcome keys, verbatim: they must match the catalogue keys the bets will carry. */
  outcomeKeys: string[];
  /** Creation bond to attach, in motes. Held by the vault, refunded at clean settlement. */
  bondMotes: string;
}

export interface CasperChainPort {
  readonly network: CasperNetwork;
  /** Current block height — a cheap liveness probe. */
  getBlockHeight(): Promise<number>;
  /** Escrow a stake into the parimutuel vault. Returns the on-chain deploy. */
  placeBet(input: PlaceBetInput): Promise<DeployResult>;
  /** Post a resolution and trigger settlement. */
  resolveMarket(input: ResolveMarketInput): Promise<DeployResult>;
  /** Open a market inside the v2 vault. Rejects when no v2 vault is configured. */
  createMarket(input: CreateMarketInput): Promise<DeployResult>;
  explorerUrlForDeploy(deployHash: string): string;
}
