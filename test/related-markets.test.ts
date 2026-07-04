import { describe, it, expect } from "vitest";
import { buildCatalogue } from "@/core/catalogue";
import { relatedMarkets } from "@/core/related-markets";
import type { Market } from "@/core/types";

const testnet = buildCatalogue("testnet");
const bySlug = (slug: string): Market => testnet.find((m) => m.slug === slug)!;

describe("relatedMarkets", () => {
  it("never includes the market itself", () => {
    const m = bySlug("btc-150k-aug");
    expect(relatedMarkets(m, testnet).some((r) => r.slug === m.slug)).toBe(false);
  });

  it("surfaces same-category siblings", () => {
    const btc = bySlug("btc-150k-aug"); // rwa
    const related = relatedMarkets(btc, testnet);
    expect(related.length).toBeGreaterThan(0);
    expect(related.every((r) => r.category === "rwa")).toBe(true);
  });

  it("ranks a shared-subject sibling above a mere same-category one", () => {
    const price = bySlug("cspr-price-05-aug");
    const related = relatedMarkets(price, testnet);
    // Other CSPR markets share the "cspr" token → they rank first.
    expect(related[0].slug.includes("cspr")).toBe(true);
  });

  it("respects the limit", () => {
    const btc = bySlug("btc-150k-aug");
    expect(relatedMarkets(btc, testnet, 2).length).toBeLessThanOrEqual(2);
  });

  it("only returns markets on the same network", () => {
    const btcTest = bySlug("btc-150k-aug");
    const mixed = [...testnet, ...buildCatalogue("mainnet")];
    expect(relatedMarkets(btcTest, mixed).every((r) => r.network === "testnet")).toBe(true);
  });

  it("returns nothing for a category-of-one with no shared subject", () => {
    const flip = bySlug("coin-flip-5m"); // the only provably-fair market
    expect(relatedMarkets(flip, testnet)).toEqual([]);
  });

  it("is deterministic", () => {
    const m = bySlug("eth-6k-aug");
    expect(relatedMarkets(m, testnet).map((r) => r.slug)).toEqual(
      relatedMarkets(m, testnet).map((r) => r.slug),
    );
  });
});
