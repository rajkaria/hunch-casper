/**
 * ClockPort — the only source of "now" for schedule-dependent logic.
 *
 * Recurring rounds are defined against the wall clock, but the catalogue's determinism invariant
 * (AGENTS.md) requires that tests never drift with it. Injecting the clock keeps both: production
 * reads real time, tests pin a literal and advance it deliberately.
 */
export interface ClockPort {
  /** Epoch milliseconds. */
  now(): number;
}
