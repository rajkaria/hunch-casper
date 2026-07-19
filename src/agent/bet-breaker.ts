/**
 * The paid-but-not-placed circuit breaker.
 *
 * An agent bet is two transactions: the agent pays the treasury over x402, then the operator
 * escrows the stake on chain. There is no refund path between them — if the escrow fails after the
 * payment lands, the agent has bought nothing, and the money is gone. That is inherent to the
 * two-transaction model, and per-tick the loss is small and bounded.
 *
 * What is NOT acceptable is repeating it forever. When the escrow path broke (a proxy-ABI
 * mismatch, then an HTTP transport that rejected every submit), each tick dutifully paid the
 * treasury and recorded nothing, for hours, while every health check stayed green — the economy
 * looked merely quiet. A bounded loss repeated on a cron is an unbounded loss.
 *
 * So: count CONSECUTIVE paid-but-not-placed failures, and once they reach the threshold, stop
 * betting. Resolution is never gated by this — it pays people what they are owed, and withholding
 * it to protect the operator's purse would strand user money. A successful placement clears the
 * counter; an operator can also clear it explicitly once the cause is fixed.
 *
 * State lives here in module memory and rides the KV envelope (`adapters/persist/economy-state`),
 * because serverless instances are short-lived: a counter that resets on every cold start would
 * never reach a threshold, and the breaker would be decoration.
 */

/** Consecutive paid-but-not-placed failures that trip the breaker. */
export const BREAKER_TRIP_THRESHOLD = 3;

export interface BetFailure {
  agentId: string;
  /** The settlement the agent paid for and did not get a bet from — reconcile against this. */
  deployHash: string;
  reason: string;
  ts: number;
}

export interface BreakerSnapshot {
  consecutiveFailures: number;
  lastFailure: BetFailure | null;
  /** When the breaker tripped, or `null` while it is closed. */
  trippedAt: number | null;
}

const state: BreakerSnapshot = { consecutiveFailures: 0, lastFailure: null, trippedAt: null };

/**
 * Record that an agent paid and the bet did not land. Trips the breaker on the threshold-th
 * consecutive failure.
 */
export function recordPaidNotPlaced(failure: BetFailure): BreakerSnapshot {
  state.consecutiveFailures += 1;
  state.lastFailure = failure;
  if (state.consecutiveFailures >= BREAKER_TRIP_THRESHOLD && state.trippedAt === null) {
    state.trippedAt = failure.ts;
  }
  return { ...state };
}

/**
 * Record a bet that actually landed. Clears the counter: the failures the breaker guards against
 * are consecutive ones, and a placement proves the money path works right now.
 */
export function recordPlacement(): void {
  state.consecutiveFailures = 0;
  state.lastFailure = null;
  state.trippedAt = null;
}

/** True while betting is halted. Never gates resolution. */
export function bettingHalted(): boolean {
  return state.trippedAt !== null;
}

export function breakerSnapshot(): BreakerSnapshot {
  return { ...state };
}

/**
 * Operator reset: close the breaker and let the fleet bet again. Deliberately explicit — a
 * tripped breaker means money was lost without anything bought, so it should take a human who
 * has read the last failure and fixed the cause, not a timeout.
 */
export function resetBreaker(): void {
  recordPlacement();
}

/** Snapshot for the KV envelope. */
export function exportBreakerState(): BreakerSnapshot {
  return { ...state };
}

/** Restore from the KV envelope; unknown/partial shapes leave the in-memory state alone. */
export function importBreakerState(snapshot: BreakerSnapshot): void {
  state.consecutiveFailures = Number.isFinite(snapshot.consecutiveFailures)
    ? Math.max(0, Math.floor(snapshot.consecutiveFailures))
    : 0;
  state.lastFailure = snapshot.lastFailure ?? null;
  state.trippedAt = typeof snapshot.trippedAt === "number" ? snapshot.trippedAt : null;
}
