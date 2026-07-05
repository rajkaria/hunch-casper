/**
 * Pure parimutuel odds. Odds are pool-implied probabilities — a winning outcome splits the
 * whole pool pro-rata among its backers. There is NO seeded AMM. This mirrors Hunch's
 * money-path discipline: the number the UI shows is derived from the same math the vault
 * settles with.
 */

// Relative (not `@/`) so the emitted `.d.ts` resolves inside the published SDK package.
import type { Market, OutcomeOdds } from "./types";

export function computeOdds(market: Market): OutcomeOdds[] {
  const total = BigInt(market.totalStakedMotes);
  return market.outcomes.map((outcome) => {
    const pool = BigInt(market.poolByOutcomeMotes[outcome.key] ?? "0");
    const impliedProbability = total === 0n ? 0 : Number(pool) / Number(total);
    const payoutMultiple = pool === 0n ? 0 : Number(total) / Number(pool);
    return { outcomeKey: outcome.key, impliedProbability, payoutMultiple };
  });
}

/** Format an implied probability as a percentage string, e.g. 0.6 → "60%". */
export function formatProbability(p: number): string {
  return `${Math.round(p * 100)}%`;
}
