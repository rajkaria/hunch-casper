/**
 * The Prophets — four rival bettor strategies that make the economy move. Each `decide` is a
 * pure function of a market's current pool-implied odds: no port, no chain, no LLM (the LLM only
 * narrates *why*, later, and never picks the money). Deterministic given (market, odds, seq), so
 * the swarm's behaviour is reproducible for the demo and testable offline.
 *
 *   Momentum  — backs the favourite (the crowd is usually right; ride it).
 *   Contrarian— fades the crowd, backing the longshot.
 *   Value     — hunts the most under-priced plausible outcome (best payout among the credible).
 *   Chaos     — injects noise, backing a deterministically "random" outcome.
 */

import type { Market, OutcomeOdds } from "@/core/types";
import { csprToMotes } from "@/core/types";

export type ProphetStrategy = "momentum" | "contrarian" | "value" | "chaos";

export interface Prophet {
  /** Bettor id used on the money path (`agent:<name>`). */
  id: string;
  name: string;
  strategy: ProphetStrategy;
  /** UI accent class for the dashboard. */
  accent: string;
  /** Base stake in CSPR — the strategy's conviction size. */
  stakeCspr: number;
}

export const PROPHETS: readonly Prophet[] = [
  { id: "agent:momentum", name: "Momentum", strategy: "momentum", accent: "text-up", stakeCspr: 3 },
  { id: "agent:contrarian", name: "Contrarian", strategy: "contrarian", accent: "text-down", stakeCspr: 2 },
  { id: "agent:value", name: "Value", strategy: "value", accent: "text-gold", stakeCspr: 2 },
  { id: "agent:chaos", name: "Chaos", strategy: "chaos", accent: "text-accent-2", stakeCspr: 1 },
];

export interface ProphetDecision {
  outcomeKey: string;
  amountMotes: string;
  /** A short human reason (seeds the LLM narration; not the money authority). */
  reason: string;
}

/** FNV-1a hash → non-negative int, for deterministic "chaos". */
function hash(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function label(market: Market, key: string): string {
  return market.outcomes.find((o) => o.key === key)?.label ?? key;
}

/** Decide a Prophet's bet on a market, or null if the market isn't bettable. */
export function decide(
  strategy: ProphetStrategy,
  market: Market,
  odds: OutcomeOdds[],
  seq: number,
  stakeCspr: number,
): ProphetDecision | null {
  if (market.status !== "open" || odds.length < 2) return null;

  const amountMotes = csprToMotes(stakeCspr);
  const byProb = [...odds].sort((a, b) => b.impliedProbability - a.impliedProbability);

  switch (strategy) {
    case "momentum": {
      const pick = byProb[0];
      return { outcomeKey: pick.outcomeKey, amountMotes, reason: `${label(market, pick.outcomeKey)} is the favourite — riding the crowd.` };
    }
    case "contrarian": {
      const pick = byProb[byProb.length - 1];
      return { outcomeKey: pick.outcomeKey, amountMotes, reason: `${label(market, pick.outcomeKey)} is the longshot — fading the crowd.` };
    }
    case "value": {
      // Best payout multiple among plausible outcomes (implied prob ≥ 15%); fall back to favourite.
      const plausible = odds.filter((o) => o.impliedProbability >= 0.15);
      const pool = plausible.length > 0 ? plausible : odds;
      const pick = [...pool].sort((a, b) => b.payoutMultiple - a.payoutMultiple)[0];
      return { outcomeKey: pick.outcomeKey, amountMotes, reason: `${label(market, pick.outcomeKey)} is under-priced at ${pick.payoutMultiple.toFixed(2)}× — taking the value.` };
    }
    case "chaos": {
      const pick = market.outcomes[hash(`${market.id}:${seq}`) % market.outcomes.length];
      return { outcomeKey: pick.key, amountMotes, reason: `Chaos picks ${label(market, pick.key)} — because the market least expects it.` };
    }
  }
}
