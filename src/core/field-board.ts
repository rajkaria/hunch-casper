/**
 * Reading a wide field — search and standings for a market with hundreds of candidates.
 *
 * A two-outcome market needs neither: you can see both. At 177 the board becomes a *finding*
 * problem before it is a betting one — a visitor who cannot locate their own project in one
 * keystroke never places a bet — so the search ranking and the standings order are pure
 * functions here rather than inline component logic, and both are unit-tested.
 *
 * Ordering is deliberately deterministic to the last tie: an unseeded field starts with 177 pools
 * at exactly zero, and a sort that fell back on `Array.prototype.sort`'s implementation order
 * would reshuffle the whole board on every render.
 */

// Relative (not `@/`) so the emitted `.d.ts` resolves inside the published SDK package.
import type { Market, MarketOutcome } from "./types";
import { computeOdds } from "./parimutuel-odds";

/**
 * A market this wide gets the field treatment — search box, standings, per-candidate pages —
 * instead of the row-of-chips layout. Twelve is chosen well above the widest hand-authored
 * market (four) and well below any real field, so no existing market changes shape.
 */
export const WIDE_FIELD_THRESHOLD = 12;

export function isWideField(market: Market): boolean {
  return market.outcomes.length > WIDE_FIELD_THRESHOLD;
}

/** Fold case and accents so "Sasha — Autonomous Economic Actor" is reachable by typing "sasha". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Rank outcomes against a query: exact key, then key prefix, then label prefix, then label
 * substring, then any word-start inside the label ("health oracle" finds "Phoenix Zero — x402
 * Sequencer Health Oracle…"). Ties keep the input order, so the list never reshuffles under the
 * cursor. An empty query returns the input unchanged — the caller decides the resting order.
 */
export function searchOutcomes(outcomes: readonly MarketOutcome[], query: string): MarketOutcome[] {
  const q = fold(query.trim());
  if (q.length === 0) return [...outcomes];
  const scored: Array<{ outcome: MarketOutcome; score: number; index: number }> = [];
  outcomes.forEach((outcome, index) => {
    const label = fold(outcome.label);
    const key = fold(outcome.key);
    let score = -1;
    if (key === q) score = 0;
    else if (key.startsWith(q)) score = 1;
    else if (label.startsWith(q)) score = 2;
    else if (label.includes(q)) score = 3;
    else if (label.split(/[^a-z0-9]+/).some((word) => word.startsWith(q))) score = 4;
    if (score >= 0) scored.push({ outcome, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((s) => s.outcome);
}

/** One row of the standings — everything a field row renders, already derived. */
export interface FieldRow {
  outcome: MarketOutcome;
  /** Staked on this candidate, in motes. */
  stakeMotes: string;
  /** Pool-implied probability in [0, 1]. Zero for every row while the field is unbet. */
  impliedProbability: number;
  /** Fee-inclusive payout multiple on a winning unit stake. Zero while this pool is empty. */
  payoutMultiple: number;
  /**
   * 1-based position, ties sharing a rank (three candidates on zero are all joint 1st). `null`
   * while nothing at all is staked — an unbet field has no standings, and numbering it 1…177 by
   * alphabetical accident would invent a leader that does not exist.
   */
  rank: number | null;
}

/**
 * The standings: candidates by stake (descending), ties broken by the market's own outcome order
 * so the resting board is stable. Odds are fee-inclusive — the multiple beside a candidate is what
 * a winning stake actually pays, not the gross pool ratio two fee-points above it.
 */
export function fieldRows(market: Market): FieldRow[] {
  const odds = new Map(computeOdds(market, market.feeBps).map((o) => [o.outcomeKey, o]));
  const staked = BigInt(market.totalStakedMotes) > 0n;
  const rows = market.outcomes.map((outcome, index) => {
    const o = odds.get(outcome.key);
    return {
      outcome,
      index,
      stakeMotes: market.poolByOutcomeMotes[outcome.key] ?? "0",
      impliedProbability: o?.impliedProbability ?? 0,
      payoutMultiple: o?.payoutMultiple ?? 0,
    };
  });
  rows.sort((a, b) => {
    const diff = BigInt(b.stakeMotes) - BigInt(a.stakeMotes);
    if (diff !== 0n) return diff > 0n ? 1 : -1;
    return a.index - b.index;
  });

  let rank = 0;
  let seenStake: string | null = null;
  let seenCount = 0;
  return rows.map((row) => {
    seenCount += 1;
    // Equal stake ⇒ equal rank; the next distinct stake skips the shared positions (1,1,3).
    if (row.stakeMotes !== seenStake) {
      rank = seenCount;
      seenStake = row.stakeMotes;
    }
    return {
      outcome: row.outcome,
      stakeMotes: row.stakeMotes,
      impliedProbability: row.impliedProbability,
      payoutMultiple: row.payoutMultiple,
      rank: staked ? rank : null,
    };
  });
}

/** Everything a board card shows about a wide field, without the 177 rows behind it. */
export interface FieldSummary {
  /** How many candidates are in the field. */
  candidates: number;
  /** How many of them have any stake at all. */
  backed: number;
  /** True once anything at all is staked on the market. */
  staked: boolean;
  /**
   * The leaders, most-staked first — only candidates someone actually backed, so it is empty on
   * an unbet field and shorter than `limit` on a thinly-backed one. An unbet pool is not a
   * standing: padding the podium out to `limit` with 0% rows would promote catalogue order to a
   * ranking that does not exist.
   */
  leaders: FieldRow[];
  /** Candidates not shown as leaders — the "+N more" tail. */
  rest: number;
}

/**
 * Card-sized view of a wide field: the shape of the field plus at most `limit` leaders.
 *
 * Split out of the card component so the "no leaders until something is staked" rule is a tested
 * fact rather than JSX. A 177-outcome market rendered through the normal card body stretched its
 * whole grid row; this is what the card renders instead.
 */
export function fieldSummary(market: Market, limit: number): FieldSummary {
  const staked = BigInt(market.totalStakedMotes) > 0n;
  const leaders = staked
    ? fieldRows(market)
        .filter((r) => BigInt(r.stakeMotes) > 0n)
        .slice(0, Math.max(0, limit))
    : [];
  return {
    candidates: market.outcomes.length,
    backed: backedCount(market),
    staked,
    leaders,
    rest: market.outcomes.length - leaders.length,
  };
}

/** The row for one candidate, or `undefined` if the key is not in this market's field. */
export function fieldRowFor(market: Market, outcomeKey: string): FieldRow | undefined {
  return fieldRows(market).find((r) => r.outcome.key === outcomeKey);
}

/** How many distinct candidates have any stake on them — the honest "N backed" number. */
export function backedCount(market: Market): number {
  return market.outcomes.filter((o) => BigInt(market.poolByOutcomeMotes[o.key] ?? "0") > 0n).length;
}
