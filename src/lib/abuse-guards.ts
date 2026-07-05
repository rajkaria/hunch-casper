/**
 * Demo-surface abuse guards — a creation cap and a per-trigger cooldown for the PUBLIC demo
 * endpoints. In mock mode the agent triggers (POST /api/agent/genesis/run) are deliberately
 * unauthenticated so judges can fire them, which also lets a griefer spam them and pollute the
 * judged catalogue. These helpers dampen that: they are NOT security (real mode is already
 * cron-secret-gated via x-cron-secret) — just cheap, honest rate hygiene for the open demo.
 *
 * Pure and deterministic on purpose: the cap reads a count the caller passes in, and the
 * cooldown takes `nowMs` + the state map as arguments, so both unit-test without a running
 * route or fake timers. Routes skip the guards under NODE_ENV=test unless a test opts in via
 * `ABUSE_GUARDS=on` (see `abuseGuardsActive`), keeping every existing suite untouched.
 */

/** Default ceiling on Genesis-created markets when `GENESIS_MAX_CREATED` is unset. */
export const DEFAULT_GENESIS_CAP = 12;

/**
 * Has the Genesis catalogue hit its creation ceiling? `cap` defaults to the
 * `GENESIS_MAX_CREATED` env (a number) or 12 — enough for a lively demo board, small enough
 * that a spammer can't bury the curated catalogue.
 */
export function genesisCapReached(createdCount: number, cap?: number): boolean {
  return createdCount >= (cap ?? envGenesisCap());
}

function envGenesisCap(): number {
  const raw = Number(process.env.GENESIS_MAX_CREATED);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_GENESIS_CAP;
}

/** Module-level last-fired timestamps, keyed by trigger name — the routes' shared cooldown state. */
export const TRIGGER_LAST_RUN = new Map<string, number>();

/**
 * Sliding cooldown: returns the remaining wait in ms (0 = allowed). When allowed, records
 * `nowMs` against `key` so the next call inside `minIntervalMs` is blocked. State lives in the
 * caller-supplied map (routes pass `TRIGGER_LAST_RUN`; tests pass their own).
 */
export function cooldown(
  key: string,
  nowMs: number,
  minIntervalMs: number,
  lastRun: Map<string, number>,
): number {
  const last = lastRun.get(key);
  if (last !== undefined) {
    const remainingMs = last + minIntervalMs - nowMs;
    if (remainingMs > 0) return remainingMs;
  }
  lastRun.set(key, nowMs);
  return 0;
}

/**
 * Should the route enforce the guards? Always outside test; under NODE_ENV=test only when the
 * suite opts in with `ABUSE_GUARDS=on` — existing tests hammer the triggers freely, guard tests
 * exercise them deterministically.
 */
export function abuseGuardsActive(): boolean {
  return process.env.NODE_ENV !== "test" || process.env.ABUSE_GUARDS === "on";
}

/** Test-only: forget all cooldown timestamps. */
export function __resetAbuseGuards(): void {
  TRIGGER_LAST_RUN.clear();
}
