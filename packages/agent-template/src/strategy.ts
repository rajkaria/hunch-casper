/**
 * YOUR STRATEGY. This is the only file you need to change.
 *
 * You are handed a market and its current pool-implied odds, and you return a bet or `null`.
 * That is the whole contract — everything else (discovery, x402 payment, submission, retries) is
 * handled for you in `run.ts`.
 *
 * ## What actually wins the league
 *
 * Not profit. The standings rank **calibration** — the Brier score of your implied forecasts —
 * because an agent that only backs 90 % favourites shows a tidy profit and has told nobody
 * anything. You are scored on the price you *accepted*: the outcome's implied probability at the
 * moment you bet, before your own stake moved it.
 *
 * So the winning move is not "bet on whatever is likely". It is **bet when the market's price
 * disagrees with your estimate**, and size by how much. A market at 0.30 that you believe is 0.55
 * is worth more to you than a market at 0.95 that you believe is 0.96.
 *
 * You also need volume: a season has a participation floor (see the league page), so a strategy
 * that fires twice a week will not be ranked at all, however sharp it is.
 */

export interface Outcome {
  key: string;
  label: string;
  /** The market's current implied probability for this outcome, in [0, 1]. */
  impliedProbability: number;
  /** What 1 CSPR on this outcome pays if it wins. */
  payoutMultiple: number;
}

export interface Market {
  id: string;
  slug: string;
  title: string;
  category: "casper-native" | "provably-fair" | "rwa" | "meta";
  status: string;
  deadlineIso?: string;
  totalStakedMotes: string;
  outcomes: Outcome[];
}

export interface Bet {
  outcomeKey: string;
  /** Stake in motes. 1 CSPR = 1_000_000_000 motes. */
  amountMotes: string;
  /** Your own note — it appears in the activity feed next to the bet. */
  reason: string;
}

const CSPR = 1_000_000_000n;

/** Your estimate of an outcome's true probability. Replace this with your actual edge. */
function estimateProbability(market: Market, outcome: Outcome): number {
  // The template's placeholder: mild mean-reversion. It assumes extreme prices in a thin market
  // are overreactions and drifts them toward the middle. It is a starting point, not an edge —
  // beating it is the exercise.
  const pull = 0.15;
  return outcome.impliedProbability + (0.5 - outcome.impliedProbability) * pull;
}

/**
 * Decide whether to bet on `market`, and how much.
 *
 * Return `null` to pass. Passing is a real move: a bet placed with no edge costs you money and
 * drags your calibration toward the baseline.
 */
export function decide(market: Market): Bet | null {
  // Meta-markets settle against the leaderboards — including the one scoring you. Betting them
  // would make your own record an input to your own score, so the league excludes them.
  if (market.category === "meta") return null;

  let best: { outcome: Outcome; edge: number; estimate: number } | null = null;
  for (const outcome of market.outcomes) {
    const estimate = estimateProbability(market, outcome);
    const edge = estimate - outcome.impliedProbability;
    if (!best || edge > best.edge) best = { outcome, edge, estimate };
  }
  if (!best) return null;

  // Only bet a disagreement worth paying the fee for. Below this you are paying to add noise to
  // your own calibration.
  const MIN_EDGE = 0.04;
  if (best.edge < MIN_EDGE) return null;

  // Size with the edge, bounded. An unbounded stake on a thin market moves the price you are
  // scored against — and can trip the pool-domination heuristic on your reputation record.
  const stakeCspr = Math.min(5, Math.max(1, Math.round(best.edge * 20)));

  return {
    outcomeKey: best.outcome.key,
    amountMotes: (BigInt(stakeCspr) * CSPR).toString(),
    reason: `market prices ${best.outcome.key} at ${(best.outcome.impliedProbability * 100).toFixed(0)}%, I estimate ${(best.estimate * 100).toFixed(0)}%`,
  };
}
