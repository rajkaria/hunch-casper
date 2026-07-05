/**
 * MarketStorePort — the read model AND the off-chain settlement index for markets. The chain is
 * the source of truth for money; this store is a fast index for UX + demo speed: it caches pools,
 * records bets so odds go live, and holds the settlement manifest the pure payout engine produces.
 * The real adapter (Supabase/SQLite, a later sprint) lands behind this same interface.
 */

import type { CasperNetwork } from "@/config/network";
import type { Market, MarketCategory } from "@/core/types";
import type { PayoutManifest } from "@/core/market-payout";

export interface MarketListFilter {
  network?: CasperNetwork;
  category?: MarketCategory;
  status?: Market["status"];
}

export interface RecordBetInput {
  /** `network:slug` market id (matches `Market.id`). */
  marketId: string;
  /** Bettor label — a public key or `agent:<name>`. Demo-grade attribution until S7 auth. */
  bettor: string;
  outcomeKey: string;
  amountMotes: string;
}

/** The off-chain mirror of a market's settlement — computed by the pure payout engine. */
export interface SettlementRecord {
  marketId: string;
  status: "open" | "resolved" | "void";
  winningOutcomeKey: string | null;
  /** Present once settled; the exact payout the on-chain `claim()` mirrors. */
  manifest: PayoutManifest | null;
}

/**
 * A settled market's raw stakes + manifest — the input the pure agent-PnL leaderboard folds over.
 * Exposed by the store so the boards (and the meta-markets that resolve against them) read the
 * exact money-path numbers, never an estimate.
 */
export interface SettledEntry {
  marketId: string;
  /** `bettor -> (outcomeKey -> motes)` for this market. */
  stakesByBettor: Record<string, Record<string, string>>;
  /** The settlement manifest (money authority). */
  manifest: PayoutManifest;
}

export interface MarketStorePort {
  list(filter?: MarketListFilter): Promise<Market[]>;
  get(slug: string, network: CasperNetwork): Promise<Market | null>;
  /** Record an escrowed bet so pools + implied odds go live. Returns the updated market. */
  recordBet(input: RecordBetInput): Promise<Market>;
  /**
   * Settle a market off-chain: run the pure payout engine over the recorded stakes and record
   * the manifest. `winningOutcomeKey === null` voids the round. Idempotent — re-settling returns
   * the existing record.
   */
  settle(marketId: string, winningOutcomeKey: string | null): Promise<SettlementRecord>;
  /** The settlement record for a market, or `null` if never touched. */
  settlementFor(marketId: string): Promise<SettlementRecord | null>;
  /** Every settled market's stakes + manifest (optionally one network) — feeds the PnL board. */
  settledEntries(network?: CasperNetwork): Promise<SettledEntry[]>;
}
