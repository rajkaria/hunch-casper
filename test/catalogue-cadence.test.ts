import { describe, expect, it } from "vitest";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { effectiveDeadlineMs } from "@/core/market-generator";
import { cadenceIntervalMs } from "@/core/round-schedule";

const DAY = 86_400_000;

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

  it("the recurring price market rolls on its stated cadence", () => {
    // Daily, not hourly: an hourly round costs ~276 CSPR/day and leaves the treasury five days
    // of runway. The title was changed to match — see the definition's comment.
    const def = MARKET_DEFINITIONS.find((d) => d.slug === "cspr-hourly-updown")!;
    expect(def.cadence).toBe("daily");
    const now = Date.parse("2026-09-15T13:37:00.000Z");
    expect(effectiveDeadlineMs(def, now) - effectiveDeadlineMs(def, now - DAY)).toBe(DAY);
  });

  it("every recurring market's title matches the cadence it actually runs", () => {
    // The original defect was a title promising a round the deadline never delivered. A title
    // saying "hour" on a daily market is the same lie with a different number.
    const promises: Record<string, RegExp> = { hourly: /hour/i, daily: /daily|today|day/i };
    for (const def of MARKET_DEFINITIONS) {
      const promise = promises[def.cadence];
      if (!promise) continue;
      const copy = `${def.title} ${def.subtitle ?? ""}`;
      expect(copy).toMatch(promise);
    }
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
