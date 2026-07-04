import { describe, it, expect } from "vitest";
import { MARKET_DEFINITIONS, buildCatalogue, findDefinition } from "@/core/catalogue";
import type { ResolverBinding } from "@/core/types";

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

  // ── S3: the full config-driven catalogue ────────────────────────────────────────────────

  it("ships the full 15+ catalogue", () => {
    expect(MARKET_DEFINITIONS.length).toBeGreaterThanOrEqual(15);
  });

  it("has unique slugs", () => {
    const slugs = MARKET_DEFINITIONS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("authors all seven Casper-native markets from the spec", () => {
    const casperNative = MARKET_DEFINITIONS.filter((d) => d.category === "casper-native");
    expect(casperNative.length).toBe(7);
    const metrics = new Set(casperNative.map((d) => d.resolver.metric));
    for (const m of [
      "cspr_usd",
      "cspr_mcap_usd",
      "daily_deploys",
      "active_validators",
      "staking_apy_pct",
      "total_staked_cspr",
    ]) {
      expect(metrics.has(m)).toBe(true);
    }
  });

  it("carries a coin-flip market resolved by drand", () => {
    const flip = findDefinition("coin-flip-5m");
    expect(flip?.resolver.kind).toBe("coin_flip");
    expect(flip?.resolver.source).toBe("drand");
    expect(flip?.cadence).toBe("5-minute");
  });

  it("carries the three meta / agent-performance markets", () => {
    const meta = MARKET_DEFINITIONS.filter((d) => d.category === "meta");
    expect(meta.length).toBe(3);
    expect(meta.every((d) => d.resolver.source === "internal")).toBe(true);
  });

  it("gives every definition a valid fee, cadence and deadline", () => {
    for (const d of MARKET_DEFINITIONS) {
      expect(Number.isInteger(d.feeBps)).toBe(true);
      expect(d.feeBps).toBeGreaterThanOrEqual(0);
      expect(d.feeBps).toBeLessThan(10_000);
      expect(["one-shot", "5-minute", "hourly", "weekly"]).toContain(d.cadence);
      expect(Number.isFinite(Date.parse(d.deadlineIso))).toBe(true);
    }
  });

  it("gives every definition a well-formed resolver binding", () => {
    for (const d of MARKET_DEFINITIONS) {
      const r: ResolverBinding = d.resolver;
      expect(r.metric.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      if (r.kind === "threshold") {
        expect(r.target).toBeDefined();
        expect(r.comparator).toBeDefined();
        expect(Number.isFinite(Number(r.target))).toBe(true);
      }
      if (r.kind === "nway_winner") {
        expect(d.outcomes.length).toBeGreaterThanOrEqual(2);
      }
      if (r.kind === "coin_flip") {
        expect(r.source).toBe("drand");
      }
    }
  });

  it("finds a definition by slug and misses cleanly", () => {
    expect(findDefinition("btc-150k-aug")?.category).toBe("rwa");
    expect(findDefinition("does-not-exist")).toBeUndefined();
  });
});
