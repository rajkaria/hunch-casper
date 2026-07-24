import { describe, expect, it } from "vitest";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { effectiveDeadlineMs } from "@/core/market-generator";
import { cadenceIntervalMs } from "@/core/round-schedule";

const HOUR = 3_600_000;

describe("catalogue cadence", () => {
  it("a recurring market's deadline is always in the near future", () => {
    const now = Date.parse("2026-09-15T13:37:00.000Z"); // deliberately past every Aug 1 literal
    for (const def of MARKET_DEFINITIONS) {
      const interval = cadenceIntervalMs(def.cadence);
      if (interval === null) continue;
      const deadline = effectiveDeadlineMs(def, now);
      expect(deadline).toBeGreaterThan(now);
      expect(deadline - now).toBeLessThanOrEqual(interval);
    }
  });

  it("a one-shot market keeps its literal deadline", () => {
    const def = MARKET_DEFINITIONS.find((d) => d.cadence === "one-shot")!;
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    expect(effectiveDeadlineMs(def, now)).toBe(Date.parse(def.deadlineIso));
  });

  it("the hourly market is actually hourly", () => {
    const def = MARKET_DEFINITIONS.find((d) => d.slug === "cspr-hourly-updown")!;
    expect(def.cadence).toBe("hourly");
    const now = Date.parse("2026-09-15T13:37:00.000Z");
    expect(effectiveDeadlineMs(def, now) - effectiveDeadlineMs(def, now - HOUR)).toBe(HOUR);
  });

  it("the coin flip is actually a 5-minute round", () => {
    const def = MARKET_DEFINITIONS.find((d) => d.slug === "coin-flip-5m")!;
    expect(def.cadence).toBe("5-minute");
  });

  it("no recurring market advertises a cadence its subtitle contradicts", () => {
    // The defect this pins: a market titled "this hour" carrying an eight-day deadline.
    for (const def of MARKET_DEFINITIONS) {
      if (def.cadence === "one-shot") continue;
      const interval = cadenceIntervalMs(def.cadence)!;
      const literal = Date.parse(def.deadlineIso);
      const firstRound = effectiveDeadlineMs(def, literal);
      expect(firstRound - literal).toBeLessThanOrEqual(interval);
    }
  });
});
