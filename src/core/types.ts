/**
 * Core domain types. `core/` depends only on these types and on `ports/` — never on a
 * concrete adapter, framework, or network client. This is what keeps the Casper adapter
 * swappable behind contract tests.
 */

import type { CasperNetwork } from "@/config/network";

export type MarketCategory = "casper-native" | "provably-fair" | "rwa" | "meta";

export type MarketStatus = "open" | "locked" | "resolved" | "void";

/**
 * How often a market opens a fresh round. `one-shot` markets resolve once at their deadline;
 * the recurring cadences are the 24/7 fuel the Prophet swarm trades. The engine only records
 * the cadence here (declarative) — the recurring round scheduler lands with the agent economy.
 */
export type MarketCadence = "one-shot" | "5-minute" | "hourly" | "weekly";

/** The shape of the resolution rule — what kind of question the Arbiter answers. */
export type ResolverKind =
  /** A metric crosses a target by the deadline → binary YES/NO. */
  | "threshold"
  /** A value moved up or down over a window → UP/DOWN. */
  | "direction"
  /** Pick the single winning candidate among N (outcome keys are the candidates). */
  | "nway_winner"
  /** A public randomness beacon (drand) decides Heads/Tails/Tie. */
  | "coin_flip"
  /** Resolved from the economy's own internal agent state (PnL, accuracy). */
  | "agent_metric";

/** Where the Arbiter reads the deciding datum. Each maps to a real S6+ oracle adapter. */
export type ResolverSource =
  /** Casper chain data (deploys, validators, staking) via CSPR.cloud. */
  | "cspr_cloud"
  /** Token / asset spot price via CoinGecko. */
  | "coingecko"
  /** Macro RWA feed (T-bill yield, gold, stablecoin supply). */
  | "macro_feed"
  /** drand randomness beacon (provably-fair flip). */
  | "drand"
  /** The agent economy's own leaderboards (meta-markets). */
  | "internal";

export type ResolverComparator = "gte" | "lte";

/**
 * A resolver binding declares, in one config object, exactly how a market resolves. It is data,
 * not code: the S3 generator carries it into the catalogue; the S6 Arbiter/oracle reads it to
 * fetch the deciding datum and pick the winning outcome; the UI and README render it as the
 * market's resolution rule. Keeping it declarative is what makes "every market is
 * agent-resolvable with no manual intervention" a checkable property rather than a claim.
 */
export interface ResolverBinding {
  kind: ResolverKind;
  source: ResolverSource;
  /** The metric/asset key the source is read for (e.g. "cspr_usd", "daily_deploys", "btc_usd"). */
  metric: string;
  /** Target value for threshold markets, in the metric's native unit (string for precision). */
  target?: string;
  /** Comparator for threshold markets (default reading: `metric <comparator> target`). */
  comparator?: ResolverComparator;
  /** One-line human description used in the resolution rationale + docs. */
  description: string;
}

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
