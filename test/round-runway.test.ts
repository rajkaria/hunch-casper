import { describe, expect, it } from "vitest";
import { roundsPerDay, dailyRolloverCostMotes, runwayDays } from "@/core/cadence";

const CSPR = 1_000_000_000n;

describe("round runway", () => {
  it("counts rounds per day per cadence", () => {
    expect(roundsPerDay("hourly")).toBe(24);
    expect(roundsPerDay("5-minute")).toBe(288);
    expect(roundsPerDay("weekly")).toBe(0);
    expect(roundsPerDay("one-shot")).toBe(0);
  });

  it("prices a day of rollover at the measured create cost", () => {
    // 24 rounds/day x 3.74 CSPR measured create = 89.76 CSPR
    expect(BigInt(dailyRolloverCostMotes(["hourly"]))).toBe((8976n * CSPR) / 100n);
  });

  it("sums across several recurring markets", () => {
    const one = BigInt(dailyRolloverCostMotes(["hourly"]));
    expect(BigInt(dailyRolloverCostMotes(["hourly", "hourly"]))).toBe(one * 2n);
  });

  it("computes runway in whole days, rounding down", () => {
    expect(runwayDays((1000n * CSPR).toString(), (100n * CSPR).toString())).toBe(10);
    expect(runwayDays((150n * CSPR).toString(), (100n * CSPR).toString())).toBe(1);
  });

  it("a zero daily cost is unbounded runway, not a divide-by-zero", () => {
    expect(runwayDays((1000n * CSPR).toString(), "0")).toBe(Number.POSITIVE_INFINITY);
  });

  it("an empty treasury has zero runway", () => {
    expect(runwayDays("0", (100n * CSPR).toString())).toBe(0);
  });

  it("a 5-minute cadence is more than ten times an hourly one", () => {
    // The number that decides whether The Flip can run at its advertised cadence at all.
    const flip = BigInt(dailyRolloverCostMotes(["5-minute"]));
    const hourly = BigInt(dailyRolloverCostMotes(["hourly"]));
    expect(flip / hourly).toBe(12n);
  });
});
