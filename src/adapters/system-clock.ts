/**
 * The production clock. Trivial by design — its only job is to be the one place `Date.now()` is
 * read for schedule-dependent logic, so every other module can be tested against a pinned clock.
 */

import type { ClockPort } from "@/ports/clock";

/** Wall-clock adapter — the production clock. */
export function createSystemClock(): ClockPort {
  return { now: () => Date.now() };
}
