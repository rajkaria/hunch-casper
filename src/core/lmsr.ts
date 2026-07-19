/**
 * LMSR — Hanson's Logarithmic Market Scoring Rule, the continuous-liquidity engine for flagship
 * markets (S28). Parimutuel stays for the long tail; LMSR is for markets that want a live quote and
 * exit-before-resolution. Same money-path discipline as everywhere else: the quotes are
 * deterministic math, and the on-chain `lmsr_market.rs` mirrors this reference (parity vectors).
 *
 * ## The rule
 *
 *   cost     C(q) = b · ln( Σ exp(q_i / b) )
 *   price    p_i  = exp(q_i/b) / Σ exp(q_j/b)          (the instantaneous cost of the next share)
 *   trade    cost to move q → q'  =  C(q') − C(q)      (negative = the maker pays you, i.e. a sell)
 *
 * `b` is the liquidity parameter: bigger `b` = deeper book, smaller price impact, but a larger
 * worst-case subsidy. The maker's bounded loss is exactly **b · ln(n)** for n outcomes — the most
 * the maker can ever be down, and the number the risk controls budget against.
 *
 * Numerics: prices and costs use the log-sum-exp trick (subtract the max exponent) so `exp` never
 * overflows even for large `q/b`. This is the float reference; the contract uses fixed-point and
 * agrees to a documented tolerance (see `lmsr_market.rs` / decision D27).
 */

export interface LmsrState {
  /** Liquidity parameter b > 0. Larger = deeper, costlier to subsidise. */
  b: number;
  /** Outstanding shares per outcome (index-aligned). Length n ≥ 2. */
  q: number[];
}

function assertState(state: LmsrState): void {
  if (!(state.b > 0)) throw new Error("lmsr: b must be > 0");
  if (state.q.length < 2) throw new Error("lmsr: need at least two outcomes");
}

/** log( Σ exp(q_i / b) ), computed stably by factoring out the max term. */
function logSumExp(q: number[], b: number): number {
  const scaled = q.map((x) => x / b);
  const max = Math.max(...scaled);
  let sum = 0;
  for (const s of scaled) sum += Math.exp(s - max);
  return max + Math.log(sum);
}

/** The LMSR cost function C(q) = b · ln(Σ exp(q_i/b)). */
export function lmsrCost(state: LmsrState): number {
  assertState(state);
  return state.b * logSumExp(state.q, state.b);
}

/** Instantaneous prices p_i — a probability distribution over outcomes (sums to 1). */
export function lmsrPrices(state: LmsrState): number[] {
  assertState(state);
  const scaled = state.q.map((x) => x / state.b);
  const max = Math.max(...scaled);
  const exps = scaled.map((s) => Math.exp(s - max));
  const denom = exps.reduce((a, c) => a + c, 0);
  return exps.map((e) => e / denom);
}

/**
 * Cost to buy `delta` shares (delta > 0) or the proceeds of selling (delta < 0) on outcome `i`.
 * Positive = the trader pays; negative = the maker pays the trader. Round-trip-neutral: buying then
 * immediately selling the same delta nets to zero (no free money), which the tests assert.
 */
export function lmsrTradeCost(state: LmsrState, i: number, delta: number): number {
  assertState(state);
  if (i < 0 || i >= state.q.length) throw new Error("lmsr: outcome index out of range");
  const before = lmsrCost(state);
  const q2 = state.q.slice();
  q2[i] += delta;
  const after = lmsrCost({ b: state.b, q: q2 });
  return after - before;
}

/** Apply a trade, returning the new state (does not mutate the input). */
export function lmsrApply(state: LmsrState, i: number, delta: number): LmsrState {
  const q = state.q.slice();
  q[i] += delta;
  return { b: state.b, q };
}

/** The maker's worst-case loss (maximum subsidy) for this book: b · ln(n). */
export function lmsrBoundedLoss(b: number, n: number): number {
  if (!(b > 0) || n < 2) throw new Error("lmsr: b > 0 and n ≥ 2 required");
  return b * Math.log(n);
}

/**
 * The maker's realised P&L if outcome `i` wins from the current state, relative to an initial
 * uniform book `q0` (all zeros). The maker collected `C(q) − C(q0)` from traders and pays out `q_i`
 * (each winning share redeems for 1). P&L = collected − payout; it is bounded below by −b·ln(n).
 */
export function lmsrMakerPnlIfWins(state: LmsrState, i: number, q0?: number[]): number {
  assertState(state);
  const zero = q0 ?? state.q.map(() => 0);
  const collected = lmsrCost(state) - lmsrCost({ b: state.b, q: zero });
  const payout = state.q[i] - zero[i];
  return collected - payout;
}
