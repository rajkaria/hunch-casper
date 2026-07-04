import { describe, it, expect } from "vitest";
import { decide } from "@/core/prophet-strategies";
import { buildMarket, findDefinition } from "@/core/catalogue";
import { csprToMotes } from "@/core/types";
import { computeOdds } from "@/core/parimutuel-odds";

// btc-150k-aug seed: yes 700 CSPR (prob ~0.23), no 2300 CSPR (prob ~0.77) → NO is the favourite.
const market = buildMarket(findDefinition("btc-150k-aug")!, "testnet");
const odds = computeOdds(market);

describe("Prophet strategies", () => {
  it("Momentum backs the favourite", () => {
    expect(decide("momentum", market, odds, 0, 1)!.outcomeKey).toBe("no");
  });

  it("Contrarian backs the longshot", () => {
    expect(decide("contrarian", market, odds, 0, 1)!.outcomeKey).toBe("yes");
  });

  it("Value takes the higher-multiple plausible outcome", () => {
    // Both outcomes are plausible (≥15%); yes pays 4.28× vs no 1.30× → Value picks yes.
    expect(decide("value", market, odds, 0, 1)!.outcomeKey).toBe("yes");
  });

  it("Chaos is deterministic per (market, seq)", () => {
    const a = decide("chaos", market, odds, 7, 1)!;
    const b = decide("chaos", market, odds, 7, 1)!;
    expect(a.outcomeKey).toBe(b.outcomeKey);
    expect(market.outcomes.some((o) => o.key === a.outcomeKey)).toBe(true);
  });

  it("sizes the stake by the strategy's conviction", () => {
    expect(decide("momentum", market, odds, 0, 3)!.amountMotes).toBe(csprToMotes(3));
  });

  it("skips a market that isn't open", () => {
    expect(decide("momentum", { ...market, status: "resolved" }, odds, 0, 1)).toBeNull();
  });
});
