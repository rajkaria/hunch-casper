/**
 * Query metering + pricing (S26) — the seam that turns the oracle into a product other protocols
 * can buy. Pure and deterministic: given a caller, the current time, and the meter state, it says
 * whether this query is inside the free ecosystem tier or must be paid for via x402, and at what
 * price. The same meter fronts the S19 reputation queries, so "reputation is free now, metered
 * later" is a config change, not a rewrite.
 *
 * Free tier: a fixed number of queries per rolling window per caller. Beyond that, x402 kicks in.
 * The state is a caller→window map the route owns (in-process demo, KV behind the same shape for a
 * real deployment) — passed in so this stays pure and unit-testable, the `abuse-guards.ts` pattern.
 */

export interface QueryTierConfig {
  /** Free queries allowed per caller per window. */
  freePerWindow: number;
  /** Rolling window length, ms. */
  windowMs: number;
  /** Price of a paid query, in motes. */
  paidPriceMotes: string;
}

export const DEFAULT_QUERY_TIER: QueryTierConfig = {
  freePerWindow: 20,
  windowMs: 60 * 60 * 1000, // 1 hour
  paidPriceMotes: "100000000", // 0.1 CSPR per paid query
};

export interface MeterWindow {
  /** Epoch ms the current window started. */
  windowStartMs: number;
  /** Queries counted in the current window. */
  count: number;
}

export interface MeterDecision {
  /** Whether this query is covered by the free tier (no payment needed). */
  free: boolean;
  /** Whether the caller must present an x402 payment to proceed. */
  requiresPayment: boolean;
  /** Free queries remaining in the window AFTER this one (0 when the query is paid). */
  remainingFree: number;
  /** The price to charge if payment is required, in motes. */
  priceMotes: string;
}

/** Read the effective tier config from env, falling back to the defaults. */
export function queryTierFromEnv(): QueryTierConfig {
  const free = Number(process.env.ORACLE_FREE_QUERIES_PER_HOUR);
  const price = process.env.ORACLE_PAID_QUERY_MOTES;
  return {
    freePerWindow: Number.isFinite(free) && free >= 0 ? free : DEFAULT_QUERY_TIER.freePerWindow,
    windowMs: DEFAULT_QUERY_TIER.windowMs,
    paidPriceMotes: price && /^\d+$/.test(price) ? price : DEFAULT_QUERY_TIER.paidPriceMotes,
  };
}

/**
 * Decide whether a caller's next query is free or paid, and RECORD it against the free tier when it
 * is free. Rolls the window when it has elapsed. Mutates `state[caller]` only when the query is
 * counted as free — a paid query does not consume free quota (you paid, so it shouldn't also burn a
 * free slot). Pure aside from the injected map.
 */
export function meterQuery(
  caller: string,
  nowMs: number,
  state: Map<string, MeterWindow>,
  config: QueryTierConfig = DEFAULT_QUERY_TIER,
): MeterDecision {
  const window = state.get(caller);
  const rolled = !window || nowMs - window.windowStartMs >= config.windowMs;
  const current: MeterWindow = rolled ? { windowStartMs: nowMs, count: 0 } : window;

  if (current.count < config.freePerWindow) {
    // Free slot available — consume it.
    const updated: MeterWindow = { windowStartMs: current.windowStartMs, count: current.count + 1 };
    state.set(caller, updated);
    return {
      free: true,
      requiresPayment: false,
      remainingFree: config.freePerWindow - updated.count,
      priceMotes: "0",
    };
  }

  // Free tier exhausted — payment required. Do NOT mutate the window (the free count stays maxed).
  if (rolled) state.set(caller, current); // still persist the rolled (empty→maxed?) window start
  return {
    free: false,
    requiresPayment: true,
    remainingFree: 0,
    priceMotes: config.paidPriceMotes,
  };
}
