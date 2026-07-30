/**
 * Pure parimutuel odds. Odds are pool-implied probabilities — a winning outcome splits the
 * whole pool pro-rata among its backers. There is NO seeded AMM. This mirrors Hunch's
 * money-path discipline: the number the UI shows is derived from the same math the vault
 * settles with.
 */

// Relative (not `@/`) so the emitted `.d.ts` resolves inside the published SDK package.
import type { Market, OutcomeOdds } from "./types";

/**
 * Pool-implied odds for every outcome.
 *
 * `feeBps` decides what the payout multiple MEANS. Pass the market's own `feeBps` and the
 * multiple is fee-inclusive — the same semantics `previewPayoutMotes` settles with (fee comes off
 * the LOSING pool only, winners keep their stake plus the net losing pool pro-rata), so the
 * number beside an outcome is the number a winning unit stake actually pays. Omit it (default 0)
 * and the multiple is gross `total / pool` — kept for callers that want the raw pool ratio. The
 * 2%-fee mismatch this closes: an even market showed "2.00×" beside a bet preview that honestly
 * said 1.98.
 */
export function computeOdds(market: Market, feeBps: number = 0): OutcomeOdds[] {
  const total = BigInt(market.totalStakedMotes);
  return market.outcomes.map((outcome) => {
    const pool = BigInt(market.poolByOutcomeMotes[outcome.key] ?? "0");
    const impliedProbability = total === 0n ? 0 : Number(pool) / Number(total);
    // Mirrors the settlement algorithm in `market-payout.ts` for a winning unit stake: the stake
    // comes back whole, plus its share of the losing pool net of fee. With feeBps 0 this is
    // exactly total / pool.
    const losingNetOfFee = (Number(total - pool) * (10_000 - feeBps)) / 10_000;
    const payoutMultiple = pool === 0n ? 0 : 1 + losingNetOfFee / Number(pool);
    return { outcomeKey: outcome.key, impliedProbability, payoutMultiple };
  });
}

/** Format an implied probability as a percentage string, e.g. 0.6 → "60%". */
export function formatProbability(p: number): string {
  return `${Math.round(p * 100)}%`;
}
