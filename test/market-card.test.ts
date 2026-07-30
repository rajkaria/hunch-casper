/**
 * Board presentation helpers. Round slugs contain `#` (`cspr-hourly-updown#20658`), so every
 * market link must percent-encode the slug or the browser treats the round index as a URL
 * fragment and lands on the wrong market; status copy must say when a market is no longer open;
 * and every "N live" claim must count only `open` markets — the board once advertised resolved
 * rounds as live.
 */

import { describe, it, expect } from "vitest";
import { buildCatalogue } from "@/core/catalogue";
import {
  countLiveMarkets,
  liveCountsByCategory,
  marketHref,
  marketStatusChip,
} from "@/components/market-card";
import { decodeSlugParam, marketApiPath } from "@/components/use-markets";
import type { Market, MarketStatus } from "@/core/types";

const testnet = buildCatalogue("testnet");
const base = testnet[0];

const withStatus = (status: MarketStatus, extra: Partial<Market> = {}): Market => ({
  ...base,
  ...extra,
  status,
});

const ROUND_SLUG = "cspr-hourly-updown#20658";

describe("marketHref", () => {
  it("leaves a kebab-case catalogue slug readable", () => {
    expect(marketHref("btc-150k-aug")).toBe("/markets/btc-150k-aug");
  });

  it("percent-encodes a round slug's `#`", () => {
    expect(marketHref(ROUND_SLUG)).toBe("/markets/cspr-hourly-updown%2320658");
  });

  it("never lets the round index become a URL fragment", () => {
    const url = new URL(marketHref(ROUND_SLUG), "https://casper.playhunch.xyz");
    expect(url.hash).toBe("");
    expect(decodeURIComponent(url.pathname)).toBe(`/markets/${ROUND_SLUG}`);
  });
});

describe("marketApiPath", () => {
  it("keeps the query string when the slug contains `#`", () => {
    // Raw interpolation would truncate at `#` and silently drop `network=` — the exact bug.
    const url = new URL(`${marketApiPath(ROUND_SLUG)}?network=testnet&fresh=1`, "https://casper.playhunch.xyz");
    expect(url.hash).toBe("");
    expect(url.searchParams.get("network")).toBe("testnet");
    expect(url.searchParams.get("fresh")).toBe("1");
  });

  it("round-trips the slug through one server-side decode", () => {
    const lastSegment = marketApiPath(ROUND_SLUG).split("/").at(-1)!;
    expect(decodeURIComponent(lastSegment)).toBe(ROUND_SLUG);
  });
});

describe("decodeSlugParam", () => {
  it("decodes the percent-encoded param Next hands the detail page", () => {
    expect(decodeSlugParam("cspr-hourly-updown%2320658")).toBe(ROUND_SLUG);
  });

  it("is a no-op on an already-decoded slug", () => {
    expect(decodeSlugParam(ROUND_SLUG)).toBe(ROUND_SLUG);
    expect(decodeSlugParam("btc-150k-aug")).toBe("btc-150k-aug");
  });

  it("passes malformed escapes through instead of throwing", () => {
    expect(decodeSlugParam("100%zz")).toBe("100%zz");
  });

  it("composes with marketApiPath so the API sees the store's slug", () => {
    // Both arrival shapes (Next encoded, or a future Next that decodes) end at the same path.
    const fromEncoded = marketApiPath(decodeSlugParam("cspr-hourly-updown%2320658"));
    const fromDecoded = marketApiPath(decodeSlugParam(ROUND_SLUG));
    expect(fromEncoded).toBe("/api/markets/cspr-hourly-updown%2320658");
    expect(fromDecoded).toBe(fromEncoded);
  });
});

describe("marketStatusChip", () => {
  it("renders no chip for an open market", () => {
    expect(marketStatusChip(withStatus("open"))).toBeNull();
  });

  it("labels a locked market", () => {
    expect(marketStatusChip(withStatus("locked"))).toBe("Locked");
  });

  it("labels a void market", () => {
    expect(marketStatusChip(withStatus("void"))).toBe("Void");
  });

  it("shows the winning outcome's human label on a resolved market", () => {
    const winner = base.outcomes[0];
    const chip = marketStatusChip(withStatus("resolved", { resolvedOutcomeKey: winner.key }));
    expect(chip).toBe(`Resolved · ${winner.label}`);
  });

  it("falls back to the raw key when the winner isn't among the outcomes", () => {
    const chip = marketStatusChip(withStatus("resolved", { resolvedOutcomeKey: "mystery" }));
    expect(chip).toBe("Resolved · mystery");
  });
});

describe("live counts", () => {
  const board: Market[] = [
    withStatus("open", { category: "casper-native" }),
    withStatus("open", { category: "rwa" }),
    withStatus("locked", { category: "rwa" }),
    withStatus("resolved", { category: "meta", resolvedOutcomeKey: base.outcomes[0].key }),
    withStatus("void", { category: "provably-fair" }),
  ];

  it("counts only open markets as live", () => {
    expect(countLiveMarkets(board)).toBe(2);
  });

  it("splits live counts by category, defaulting every category to zero", () => {
    expect(liveCountsByCategory(board)).toEqual({
      "casper-native": 1,
      "provably-fair": 0,
      rwa: 1,
      meta: 0,
    });
  });

  it("reports zero on an empty board", () => {
    expect(countLiveMarkets([])).toBe(0);
    expect(Object.values(liveCountsByCategory([]))).toEqual([0, 0, 0, 0]);
  });
});
