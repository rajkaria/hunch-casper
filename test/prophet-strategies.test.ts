import { describe, it, expect } from "vitest";
import { decide, PROPHETS, MAX_CONVICTION_MULTIPLIER } from "@/core/prophet-strategies";
import { NATIVE_TRANSFER_MINIMUM_MOTES } from "@/config/network";
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

  it("Momentum sizes up (2×) when the favourite is strong, base stake otherwise", () => {
    // btc-150k: NO is a strong favourite (~77% > 70%) → Momentum doubles down.
    expect(decide("momentum", market, odds, 0, 3)!.amountMotes).toBe(
      (BigInt(csprToMotes(3)) * 2n).toString(),
    );
    // cspr-price-05-aug: favourite ~60% (≤ 70%) → base conviction, flat stake.
    const balanced = buildMarket(findDefinition("cspr-price-05-aug")!, "testnet");
    expect(decide("momentum", balanced, computeOdds(balanced), 0, 3)!.amountMotes).toBe(csprToMotes(3));
  });

  it("skips a market that isn't open", () => {
    expect(decide("momentum", { ...market, status: "resolved" }, odds, 0, 1)).toBeNull();
  });
});

/**
 * The stake floor is a CHAIN rule, not a preference: an agent bet settles as a native CSPR
 * transfer, and Casper rejects native transfers below `NATIVE_TRANSFER_MINIMUM_MOTES`. Sizing a
 * Prophet under it does not make it bet small — it makes it unable to bet at all, silently. This
 * shipped once (3/2/2/1 against a 2.5 CSPR floor); the fleet looked idle for a whole deployment.
 */
describe("Prophet stakes clear the chainspec native-transfer floor", () => {
  it("every Prophet can actually pay its own stake on chain", () => {
    for (const prophet of PROPHETS) {
      expect(
        BigInt(csprToMotes(prophet.stakeCspr)),
        `${prophet.name} stakes ${prophet.stakeCspr} CSPR — below the ${NATIVE_TRANSFER_MINIMUM_MOTES} motes floor, so it can never bet in real mode`,
      ).toBeGreaterThanOrEqual(NATIVE_TRANSFER_MINIMUM_MOTES);
    }
  });

  it("holds for Momentum's doubled conviction bet too", () => {
    const momentum = PROPHETS.find((p) => p.strategy === "momentum")!;
    const doubled = BigInt(csprToMotes(momentum.stakeCspr)) * BigInt(MAX_CONVICTION_MULTIPLIER);
    expect(doubled).toBeGreaterThanOrEqual(NATIVE_TRANSFER_MINIMUM_MOTES);
  });
});
