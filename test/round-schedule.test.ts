import { describe, expect, it } from "vitest";
import {
  cadenceIntervalMs,
  roundIndexAt,
  roundWindow,
  currentRound,
} from "@/core/round-schedule";

const HOUR = 3_600_000;

describe("round schedule", () => {
  it("maps cadences to intervals", () => {
    expect(cadenceIntervalMs("5-minute")).toBe(300_000);
    expect(cadenceIntervalMs("hourly")).toBe(HOUR);
    expect(cadenceIntervalMs("weekly")).toBe(604_800_000);
    expect(cadenceIntervalMs("one-shot")).toBeNull();
  });

  it("indexes rounds from the epoch, so every instance agrees", () => {
    expect(roundIndexAt(0, HOUR)).toBe(0);
    expect(roundIndexAt(HOUR - 1, HOUR)).toBe(0);
    expect(roundIndexAt(HOUR, HOUR)).toBe(1);
    expect(roundIndexAt(HOUR * 3 + 5, HOUR)).toBe(3);
  });

  it("windows are half-open [open, deadline) and contiguous", () => {
    const a = roundWindow(3, HOUR);
    const b = roundWindow(4, HOUR);
    expect(a.openMs).toBe(HOUR * 3);
    expect(a.deadlineMs).toBe(HOUR * 4);
    expect(b.openMs).toBe(a.deadlineMs);
  });

  it("currentRound contains now", () => {
    const now = HOUR * 10 + 123;
    const r = currentRound("hourly", now);
    expect(r).not.toBeNull();
    expect(r!.index).toBe(10);
    expect(r!.openMs).toBeLessThanOrEqual(now);
    expect(r!.deadlineMs).toBeGreaterThan(now);
  });

  it("a one-shot market has no round", () => {
    expect(currentRound("one-shot", HOUR)).toBeNull();
  });

  it("rejects a non-positive interval rather than dividing by zero", () => {
    expect(() => roundIndexAt(1, 0)).toThrow(/interval/i);
  });
});
