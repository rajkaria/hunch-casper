/**
 * A pinned clock for tests. Time only moves when a test says so, which is what lets a recurring
 * round be exercised across its maturity boundary without sleeping or stubbing globals.
 */

import type { ClockPort } from "@/ports/clock";

export interface MockClock extends ClockPort {
  /** Move time forward by `ms`. */
  advance(ms: number): void;
  /** Jump to an absolute epoch ms. */
  set(ms: number): void;
}

/** A pinned clock. Time only moves when a test says so. */
export function createMockClock(startMs: number): MockClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}
