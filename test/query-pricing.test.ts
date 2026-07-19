import { describe, it, expect } from "vitest";
import { meterQuery, type MeterWindow, type QueryTierConfig } from "@/core/query-pricing";

const TIER: QueryTierConfig = { freePerWindow: 3, windowMs: 1000, paidPriceMotes: "100000000" };

describe("meterQuery — free tier then paid", () => {
  it("grants the free quota, then requires payment", () => {
    const state = new Map<string, MeterWindow>();
    const decisions = [0, 1, 2, 3, 4].map(() => meterQuery("caller-1", 5000, state, TIER));
    expect(decisions.slice(0, 3).every((d) => d.free)).toBe(true);
    expect(decisions[0].remainingFree).toBe(2);
    expect(decisions[2].remainingFree).toBe(0);
    // 4th and 5th are paid.
    expect(decisions[3].requiresPayment).toBe(true);
    expect(decisions[3].priceMotes).toBe("100000000");
    expect(decisions[4].requiresPayment).toBe(true);
  });

  it("rolls the window after it elapses", () => {
    const state = new Map<string, MeterWindow>();
    meterQuery("c", 0, state, TIER);
    meterQuery("c", 100, state, TIER);
    meterQuery("c", 200, state, TIER); // free exhausted
    expect(meterQuery("c", 300, state, TIER).requiresPayment).toBe(true);
    // A new window opens at t=1000.
    expect(meterQuery("c", 1000, state, TIER).free).toBe(true);
  });

  it("meters callers independently", () => {
    const state = new Map<string, MeterWindow>();
    for (let i = 0; i < 3; i++) meterQuery("a", 0, state, TIER);
    expect(meterQuery("a", 0, state, TIER).requiresPayment).toBe(true);
    // A different caller still has its full free quota.
    expect(meterQuery("b", 0, state, TIER).free).toBe(true);
  });

  it("a zero free tier makes every query paid", () => {
    const state = new Map<string, MeterWindow>();
    const zero: QueryTierConfig = { ...TIER, freePerWindow: 0 };
    expect(meterQuery("c", 0, state, zero).requiresPayment).toBe(true);
    expect(meterQuery("c", 0, state, zero).requiresPayment).toBe(true);
  });
});
