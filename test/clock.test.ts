import { describe, expect, it } from "vitest";
import { createMockClock } from "@/adapters/mock/mock-clock";
import { createSystemClock } from "@/adapters/system-clock";

describe("ClockPort", () => {
  it("mock clock is pinned and advanceable", () => {
    const clock = createMockClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });

  it("mock clock does not drift on repeated reads", () => {
    const clock = createMockClock(7);
    expect(clock.now()).toBe(clock.now());
  });

  it("system clock tracks wall time", () => {
    const before = Date.now();
    const now = createSystemClock().now();
    expect(now).toBeGreaterThanOrEqual(before);
  });
});
