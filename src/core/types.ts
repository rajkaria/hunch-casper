/**
 * Core domain types. `core/` depends only on these types and on `ports/` — never on a
 * concrete adapter, framework, or network client. This is what keeps the Casper adapter
 * swappable behind contract tests.
 */

import type { CasperNetwork } from "@/config/network";

export type MarketCategory = "casper-native" | "provably-fair" | "rwa" | "meta";

export type MarketStatus = "open" | "locked" | "resolved" | "void";

export interface MarketOutcome {
  /** Stable key used on-chain and in the money path (e.g. "yes", "up", "heads"). */
  key: string;
  /** Human label shown in the UI. */
  label: string;
}

export interface Market {
  id: string;
  slug: string;
  title: string;
  subtitle?: string;
  category: MarketCategory;
  outcomes: MarketOutcome[];
  network: CasperNetwork;
  status: MarketStatus;
  /** ISO 8601 resolution deadline. */
  deadlineIso: string;
  /** Total staked across all outcomes, in motes (1 CSPR = 1e9 motes). String for bigint safety. */
  totalStakedMotes: string;
  /** Per-outcome staked totals, in motes, keyed by outcome key. */
  poolByOutcomeMotes: Record<string, string>;
  /** Winning outcome key once resolved. */
  resolvedOutcomeKey?: string;
}

export interface Bet {
  id: string;
  marketId: string;
  outcomeKey: string;
  amountMotes: string;
  /** Bettor identity — a public key, or `agent:<name>` for a Prophet. */
  bettor: string;
  /** x402 settlement proof (deploy hash) once paid. */
  deployHash: string;
  placedAtIso: string;
}

/** Pool-implied probability + payout multiple for one outcome. */
export interface OutcomeOdds {
  outcomeKey: string;
  /** Implied probability in [0, 1], derived from pool share. */
  impliedProbability: number;
  /** Gross payout multiple on a winning unit stake. */
  payoutMultiple: number;
}

export const MOTES_PER_CSPR = 1_000_000_000n;

export function csprToMotes(cspr: number): string {
  // Avoid float drift: scale via integer nanos.
  const nanos = Math.round(cspr * 1e9);
  return BigInt(nanos).toString();
}

export function motesToCspr(motes: string): number {
  return Number(BigInt(motes)) / 1e9;
}
