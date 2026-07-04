import { describe, it, expect } from "vitest";
import { MARKET_DEFINITIONS, buildCatalogue } from "@/core/catalogue";

describe("catalogue", () => {
  it("materialises one market per definition for a network", () => {
    const cat = buildCatalogue("testnet");
    expect(cat).toHaveLength(MARKET_DEFINITIONS.length);
    expect(cat.every((m) => m.network === "testnet")).toBe(true);
  });

  it("namespaces market ids by network", () => {
    expect(buildCatalogue("mainnet")[0].id.startsWith("mainnet:")).toBe(true);
    expect(buildCatalogue("testnet")[0].id.startsWith("testnet:")).toBe(true);
  });

  it("keeps totalStaked equal to the sum of outcome pools", () => {
    for (const m of buildCatalogue("testnet")) {
      const sum = Object.values(m.poolByOutcomeMotes).reduce((a, v) => a + BigInt(v), 0n);
      expect(m.totalStakedMotes).toBe(sum.toString());
    }
  });

  it("covers all four market categories", () => {
    const cats = new Set(buildCatalogue("testnet").map((m) => m.category));
    expect(cats).toEqual(new Set(["casper-native", "provably-fair", "rwa", "meta"]));
  });

  it("has a pool entry for every outcome", () => {
    for (const m of buildCatalogue("testnet")) {
      for (const o of m.outcomes) {
        expect(m.poolByOutcomeMotes[o.key]).toBeDefined();
      }
    }
  });
});
