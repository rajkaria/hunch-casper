/**
 * LMSR risk controls (S28) — the guardrails that keep a continuous-liquidity market from becoming a
 * continuous-loss market. Pure and deterministic, mirroring the parimutuel discipline: exposure is
 * bounded, and a book moving too fast trips a circuit breaker.
 *
 *   • **Exposure cap:** the maker's worst-case loss is `b·ln(n)` (see `lmsr.ts`). A per-market cap
 *     bounds `b` so that worst case never exceeds a configured CSPR budget — you choose your maximum
 *     subsidy up front, and the cap enforces it.
 *   • **Circuit breaker:** if a single trade would move an outcome's price by more than a threshold,
 *     it is refused. This blocks a whale from yanking the book (and draining the subsidy) in one
 *     shot; they must move it in steps, giving arbitrage + LPs time to react.
 */

import { lmsrPrices, lmsrApply, lmsrBoundedLoss, type LmsrState } from "./lmsr";

export interface LmsrRiskConfig {
  /** Maximum maker subsidy (worst-case loss) allowed, in the book's cost units (motes/CSPR). */
  maxSubsidy: number;
  /** Maximum single-trade price move for any outcome, in [0,1] (e.g. 0.2 = 20 points). */
  maxPriceMovePerTrade: number;
}

export const DEFAULT_LMSR_RISK: LmsrRiskConfig = { maxSubsidy: 1000, maxPriceMovePerTrade: 0.25 };

export interface RiskCheck {
  ok: boolean;
  reason?: "exposure-cap" | "circuit-breaker";
  /** The largest single-outcome price move this trade causes, for logging. */
  maxMove?: number;
}

/** The maximum `b` whose worst-case loss (`b·ln(n)`) stays within `maxSubsidy` for n outcomes. */
export function maxLiquidityParam(maxSubsidy: number, n: number): number {
  if (!(maxSubsidy > 0) || n < 2) throw new Error("lmsr-risk: maxSubsidy > 0 and n ≥ 2 required");
  return maxSubsidy / Math.log(n);
}

/** Is a book's `b` within the exposure budget? */
export function withinExposureCap(state: LmsrState, config: LmsrRiskConfig): boolean {
  return lmsrBoundedLoss(state.b, state.q.length) <= config.maxSubsidy + 1e-9;
}

/**
 * Vet a proposed trade against the risk config: the book must be within its exposure cap, and the
 * trade must not move any outcome's price by more than the breaker threshold. Returns the largest
 * move so a caller can log/telemeter near-misses.
 */
export function vetTrade(state: LmsrState, i: number, delta: number, config: LmsrRiskConfig = DEFAULT_LMSR_RISK): RiskCheck {
  if (!withinExposureCap(state, config)) return { ok: false, reason: "exposure-cap" };
  const before = lmsrPrices(state);
  const after = lmsrPrices(lmsrApply(state, i, delta));
  let maxMove = 0;
  for (let k = 0; k < before.length; k++) maxMove = Math.max(maxMove, Math.abs(after[k] - before[k]));
  if (maxMove > config.maxPriceMovePerTrade + 1e-12) return { ok: false, reason: "circuit-breaker", maxMove };
  return { ok: true, maxMove };
}
