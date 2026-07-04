import { describe, it, expect } from "vitest";
import { computeOdds, formatProbability } from "@/core/parimutuel-odds";
import { MARKET_DEFINITIONS, buildMarket } from "@/core/catalogue";

const priceMarket = buildMarket(
  MARKET_DEFINITIONS.find((d) => d.slug === "cspr-price-05-aug")!,
  "testnet",
);

describe("parimutuel odds", () => {
  it("implied probabilities sum to ~1", () => {
    const sum = computeOdds(priceMarket).reduce((a, o) => a + o.impliedProbability, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("payout multiple equals total pool over outcome pool", () => {
    // yes: 1200 CSPR, no: 800 CSPR → total 2000
    const yes = computeOdds(priceMarket).find((o) => o.outcomeKey === "yes")!;
    expect(yes.payoutMultiple).toBeCloseTo(2000 / 1200, 6);
  });

  it("favours the larger pool with higher implied probability", () => {
    const odds = computeOdds(priceMarket);
    const yes = odds.find((o) => o.outcomeKey === "yes")!;
    const no = odds.find((o) => o.outcomeKey === "no")!;
    expect(yes.impliedProbability).toBeGreaterThan(no.impliedProbability);
  });

  it("formats a probability as a percentage", () => {
    expect(formatProbability(0.6)).toBe("60%");
    expect(formatProbability(0)).toBe("0%");
  });
});
