/**
 * The suite's frozen "now" — registered as a vitest `setupFiles` entry, so it applies to EVERY
 * test file without any of them opting in.
 *
 * Why this exists: the catalogue's deadlines are fixed literals on purpose (see `catalogue.ts` —
 * deterministic data keeps tests stable and the demo reproducible), but a market's `locked` status
 * is DERIVED by comparing those literals against a clock, and in tests that clock was the wall
 * clock. So the catalogue was deterministic and the SUITE was not: at 2026-08-01T00:00Z every
 * "by Aug 1" market matured, `effectiveStatus()` began returning `locked`, and 67 tests across 20
 * files started throwing "betting is closed" — on a codebase nobody had touched. CI went red on a
 * calendar page turn.
 *
 * Pushing the catalogue's dates out would only re-arm the same trap for a later date. Freezing
 * `Date` takes the wall clock out of the suite altogether: a test that wants a market open gets one
 * forever, and a test that wants maturity states so — `vi.setSystemTime(...)` for wall-clock code,
 * `setLedgerClock(createMockClock(...))` / a pinned `container.clock` for `ClockPort` code — rather
 * than waiting for the calendar to agree with it.
 *
 * Deliberately import-free: a `setupFiles` module is loaded before every test file's own imports,
 * so importing app code here would fix `config/network.ts`'s env snapshot before tests that stub
 * `NEXT_PUBLIC_*_VAULT_V2` in `beforeAll` ever run. Nothing but vitest belongs in this file.
 */

import { beforeEach, vi } from "vitest";

/**
 * The instant every test starts at unless it says otherwise. It has to sit inside a window the
 * fixtures bound on three sides —
 *
 *   - AFTER the league epoch (2026-07-13, `core/seasons.ts`) by more than a week, or the current
 *     season sits at a negative index and the archive comes back empty while every health check
 *     still reads fine.
 *   - AFTER the retired Aug 1 cohort's deadline, because `catalogue.test.ts` holds a `retired`
 *     market to being settled history — a matured market whose deadline is still ahead of "now" is
 *     a contradiction in terms.
 *   - BEFORE the earliest LIVE deadline (the weekly meta-markets, 2026-08-03T00:00Z), so every
 *     market that is supposed to be tradable reads `open` and can take a bet.
 *
 * `test/frozen-clock-contract.test.ts` asserts all three against the live catalogue, so a market
 * authored outside the window fails one test that names the slug rather than 67 that say "betting
 * is closed".
 */
export const TEST_NOW_ISO = "2026-08-01T12:00:00.000Z";

/** `TEST_NOW_ISO` in epoch milliseconds. */
export const TEST_NOW_MS = Date.parse(TEST_NOW_ISO);

beforeEach(() => {
  // `Date` only — timers stay real, so nothing that awaits a `setTimeout` (confirmation polls,
  // retry backoff) has to know this is here. It pins every wall-clock read at once: the container's
  // system clock, the Arbiter's sweep budget, `new Date().toISOString()` stamps.
  //
  // In `beforeEach`, not once at load: a test that moves time (`vi.setSystemTime`) or hands back a
  // real clock (`vi.useRealTimers`) must not leak that into the next one.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TEST_NOW_MS);
});
