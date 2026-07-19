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

/**
 * Momentum's conviction multiplier on a strong favourite (see the `momentum` case). Exported so
 * the treasury/purse arithmetic in `agent/economy.ts` sizes a round by what an agent can ACTUALLY
 * spend, not by its base stake — an agent that doubles down and then cannot afford the round it
 * was cleared for is exactly the throttle bug the cadence planner exists to avoid.
 */
export const MAX_CONVICTION_MULTIPLIER = 2;

/**
 * Stakes are floored by the chain, not by taste: every agent bet settles as a NATIVE CSPR transfer
 * over the x402 rail, and Casper's chainspec rejects native transfers below
 * `NATIVE_TRANSFER_MINIMUM_MOTES` (2.5 CSPR) outright. The original 3/2/2/1 sizing put three of
 * the four Prophets under that floor, so in real mode they submitted transfers the node refused
 * (`-32016`) and silently sat out every round — the fleet looked idle rather than broken.
 *
 * Sizes now sit just above the floor, keeping the conviction ordering (Momentum highest, and it
 * still doubles on a strong favourite) while staying small enough that a funded purse lasts many
 * rounds. `config/network.ts` owns the floor; `test/prophet-strategies.test.ts` asserts every
 * Prophet clears it, so a future re-tune cannot silently reintroduce this.
 */
export const PROPHETS: readonly Prophet[] = [
  { id: "agent:momentum", name: "Momentum", strategy: "momentum", accent: "text-up", stakeCspr: 4 },
  { id: "agent:contrarian", name: "Contrarian", strategy: "contrarian", accent: "text-down", stakeCspr: 3 },
  { id: "agent:value", name: "Value", strategy: "value", accent: "text-gold", stakeCspr: 3 },
  { id: "agent:chaos", name: "Chaos", strategy: "chaos", accent: "text-accent-2", stakeCspr: 3 },
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
      // Conviction sizing: when the favourite is strong (> 70%), Momentum backs it HARDER (2×).
      // This is what separates Momentum from a flat bet — and from the other strategies — on
      // lopsided binaries where the raw outcome pick would otherwise coincide.
      const conviction = pick.impliedProbability > 0.7 ? BigInt(MAX_CONVICTION_MULTIPLIER) : 1n;
      const staked = (BigInt(amountMotes) * conviction).toString();
      const size = conviction === 2n ? " Doubling down — the crowd is decisive." : "";
      return { outcomeKey: pick.outcomeKey, amountMotes: staked, reason: `${label(market, pick.outcomeKey)} is the favourite — riding the crowd.${size}` };
    }
    case "contrarian": {
      const pick = byProb[byProb.length - 1];
      return { outcomeKey: pick.outcomeKey, amountMotes, reason: `${label(market, pick.outcomeKey)} is the longshot — fading the crowd.` };
    }
    case "value": {
      // Best payout multiple among plausible outcomes (implied prob ≥ 15%); fall back to favourite.
      const plausible = odds.filter((o) => o.impliedProbability >= 0.15);
      const pool = plausible.length > 0 ? plausible : odds;
      const best = [...pool].sort((a, b) => b.payoutMultiple - a.payoutMultiple)[0];
      // Only chase the longshot if it actually pays for the risk (≥ 1.8×). Otherwise there's no
      // real edge, so Value takes the favourite — this stops it from rubber-stamping Contrarian on
      // near-even binaries, keeping the four strategies genuinely distinct.
      const pick = best.payoutMultiple >= 1.8 ? best : byProb[0];
      const why = pick === best
        ? `${label(market, pick.outcomeKey)} is under-priced at ${pick.payoutMultiple.toFixed(2)}× — taking the value.`
        : `no outcome pays enough for the risk — ${label(market, pick.outcomeKey)} is the value-safe favourite.`;
      return { outcomeKey: pick.outcomeKey, amountMotes, reason: why };
    }
    case "chaos": {
      const pick = market.outcomes[hash(`${market.id}:${seq}`) % market.outcomes.length];
      return { outcomeKey: pick.key, amountMotes, reason: `Chaos picks ${label(market, pick.key)} — because the market least expects it.` };
    }
  }
}
