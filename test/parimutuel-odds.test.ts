import { describe, it, expect } from "vitest";
import { computeOdds, formatProbability } from "@/core/parimutuel-odds";
import { MARKET_DEFINITIONS, buildMarket } from "@/core/catalogue";
import { previewPayoutMotes } from "@/core/market-payout";
import type { Market } from "@/core/types";

const priceMarket = buildMarket(
  MARKET_DEFINITIONS.find((d) => d.slug === "cspr-price-05-aug")!,
  "testnet",
);

describe("parimutuel odds", () => {
  it("implied probabilities sum to ~1", () => {
    const sum = computeOdds(priceMarket).reduce((a, o) => a + o.impliedProbability, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("gross payout multiple (no fee passed) equals total pool over outcome pool", () => {
    // yes: 1200 CSPR, no: 800 CSPR → total 2000
    const yes = computeOdds(priceMarket).find((o) => o.outcomeKey === "yes")!;
    expect(yes.payoutMultiple).toBeCloseTo(2000 / 1200, 6);
  });

  it("fee-inclusive multiple takes the fee off the LOSING pool only, like settlement", () => {
    // losing 800 at 2% fee → 784 distributable → 1 + 784/1200 on a winning unit stake
    const yes = computeOdds(priceMarket, priceMarket.feeBps).find((o) => o.outcomeKey === "yes")!;
    expect(priceMarket.feeBps).toBe(200);
    expect(yes.payoutMultiple).toBeCloseTo(1 + (800 * 0.98) / 1200, 6);
  });

  it("shows 1.98× — never 2.00× — on an even market at 2% fee (the audited mismatch)", () => {
    const even: Market = {
      ...priceMarket,
      totalStakedMotes: "2000000000000",
      poolByOutcomeMotes: { yes: "1000000000000", no: "1000000000000" },
    };
    const yes = computeOdds(even, 200).find((o) => o.outcomeKey === "yes")!;
    expect(yes.payoutMultiple).toBeCloseTo(1.98, 6);
  });

  it("fee-inclusive multiple agrees with previewPayoutMotes for a marginal stake", () => {
    // The preview adds the stake to its own pool first, so agreement tightens as the stake
    // shrinks — the point is that both numbers come from the SAME fee semantics.
    const stake = "10000000"; // 0.01 CSPR against a 2000 CSPR pool
    const paid = Number(
      previewPayoutMotes(priceMarket.poolByOutcomeMotes, "yes", stake, priceMarket.feeBps),
    );
    const multiple = computeOdds(priceMarket, priceMarket.feeBps).find(
      (o) => o.outcomeKey === "yes",
    )!.payoutMultiple;
    expect(paid / Number(stake)).toBeCloseTo(multiple, 3);
  });

  it("a fee of 0 reproduces the gross multiple exactly", () => {
    const gross = computeOdds(priceMarket);
    const zeroFee = computeOdds(priceMarket, 0);
    expect(zeroFee).toEqual(gross);
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
