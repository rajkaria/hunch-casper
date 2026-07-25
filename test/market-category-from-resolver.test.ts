/**
 * A community-composed market must be filed under the category its resolver actually earns.
 *
 * The composer used to stamp every user market `provably-fair` — a label that on this site means
 * one specific thing: decided by the drand public randomness beacon, no house, no edge. Two ops
 * smoke-test markets resolving from CoinGecko shipped to production wearing it, which made the
 * landing page's "Provably fair · 1 market — The Flip" read as a lie to anyone who filtered.
 *
 * The category is derived, not asserted: it follows the frozen recipe's source, so it can never
 * disagree with how the market will actually be settled.
 */

import { describe, expect, it } from "vitest";
import { categoryForResolver } from "@/core/market-category";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { composeMarket } from "@/core/market-composer";
import type { ResolverSource } from "@/core/types";

describe("category follows the resolver source", () => {
  it("drand — and only drand — is provably fair", () => {
    expect(categoryForResolver({ source: "drand", metric: "randomness" })).toBe("provably-fair");
  });

  it("Casper chain data is Casper-native", () => {
    expect(categoryForResolver({ source: "cspr_cloud", metric: "daily_deploys" })).toBe("casper-native");
  });

  it("a CSPR price is Casper-native even though the feed is a price feed", () => {
    expect(categoryForResolver({ source: "coingecko", metric: "cspr_usd" })).toBe("casper-native");
  });

  it("a non-CSPR price is RWA / macro", () => {
    expect(categoryForResolver({ source: "coingecko", metric: "btc_usd" })).toBe("rwa");
  });

  it("a macro feed is RWA / macro", () => {
    expect(categoryForResolver({ source: "macro_feed", metric: "tbill_3m" })).toBe("rwa");
  });

  it("the economy's own boards are meta", () => {
    expect(categoryForResolver({ source: "internal", metric: "agent_pnl" })).toBe("meta");
  });
});

describe("the shipped catalogue agrees with the derivation", () => {
  it("every catalogue market's declared category is the one its resolver implies", () => {
    for (const def of MARKET_DEFINITIONS) {
      expect(
        categoryForResolver(def.resolver),
        `${def.slug} declares '${def.category}' but its ${def.resolver.source}/${def.resolver.metric} resolver implies otherwise`,
      ).toBe(def.category);
    }
  });
});

describe("the composer files a community market by its resolver", () => {
  const deps = { llm: { complete: async () => { throw new Error("no llm in this test"); } }, existing: [] };

  async function compose(source: ResolverSource, metric: string) {
    const res = await composeMarket(
      {
        claim: "Will the metric clear its target by Sept 1",
        creator: "01aa",
        network: "testnet",
        seq: 0,
        method: "threshold",
        source,
        metric,
        target: "1",
        comparator: "gte",
        deadlineIso: "2026-09-01T00:00:00.000Z",
      },
      deps as never,
    );
    if (!res.ok) throw new Error(`compose failed: ${res.message}`);
    return res.definition;
  }

  it("a CoinGecko BTC market is RWA, not provably fair", async () => {
    expect((await compose("coingecko", "btc_usd")).category).toBe("rwa");
  });

  it("a CSPR.cloud market is Casper-native, not provably fair", async () => {
    expect((await compose("cspr_cloud", "daily_deploys")).category).toBe("casper-native");
  });

  it("only a drand market earns the provably-fair label", async () => {
    expect((await compose("drand", "randomness")).category).toBe("provably-fair");
  });
});
