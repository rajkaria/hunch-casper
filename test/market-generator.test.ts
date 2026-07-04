import { describe, it, expect } from "vitest";
import { MARKET_DEFINITIONS, findDefinition } from "@/core/catalogue";
import type { MarketDefinition } from "@/core/catalogue";
import { buildAllDeployPlans, buildDeployPlan } from "@/core/market-generator";

describe("market generator (the on-chain half of the engine)", () => {
  it("produces one deploy plan per catalogue definition", () => {
    expect(buildAllDeployPlans()).toHaveLength(MARKET_DEFINITIONS.length);
  });

  it("mirrors on-chain outcome keys to the catalogue keys verbatim (bet ABI invariant)", () => {
    for (const def of MARKET_DEFINITIONS) {
      const plan = buildDeployPlan(def);
      expect(plan.init.outcomeKeys).toEqual(def.outcomes.map((o) => o.key));
    }
  });

  it("derives a positive integer deadline in epoch ms from the ISO deadline", () => {
    const def = findDefinition("btc-150k-aug")!;
    const plan = buildDeployPlan(def);
    expect(plan.init.deadlineMs).toBe(Date.parse(def.deadlineIso));
    expect(plan.init.deadlineMs).toBeGreaterThan(0);
    expect(plan.registration.deadlineMs).toBe(plan.init.deadlineMs);
  });

  it("keeps every fee in the vault's accepted range and carries the question through", () => {
    for (const def of MARKET_DEFINITIONS) {
      const plan = buildDeployPlan(def);
      expect(plan.init.feeBps).toBe(def.feeBps);
      expect(plan.init.feeBps).toBeGreaterThanOrEqual(0);
      expect(plan.init.feeBps).toBeLessThan(10_000);
      expect(plan.init.question).toBe(def.title);
      expect(plan.registration.id).toBe(def.slug);
      expect(plan.registration.question).toBe(def.title);
      expect(plan.registration.category).toBe(def.category);
    }
  });

  it("emits a JSON-serializable, address-free plan (deploy driver injects oracle/treasury)", () => {
    const plan = buildDeployPlan(findDefinition("coin-flip-5m")!);
    const round = JSON.parse(JSON.stringify(plan));
    expect(round).toEqual(plan);
    expect(JSON.stringify(plan)).not.toContain("oracle");
    expect(JSON.stringify(plan)).not.toContain("treasury");
  });

  it("rejects a fee at or above 100% (would revert ParimutuelMarket.init)", () => {
    const bad: MarketDefinition = { ...findDefinition("btc-150k-aug")!, feeBps: 10_000 };
    expect(() => buildDeployPlan(bad)).toThrow(/feeBps/);
  });

  it("rejects a single-outcome market (vault needs ≥ 2)", () => {
    const bad: MarketDefinition = {
      ...findDefinition("btc-150k-aug")!,
      outcomes: [{ key: "yes", label: "Yes" }],
    };
    expect(() => buildDeployPlan(bad)).toThrow(/at least 2 outcomes/);
  });

  it("rejects duplicate outcome keys", () => {
    const bad: MarketDefinition = {
      ...findDefinition("btc-150k-aug")!,
      outcomes: [
        { key: "yes", label: "Yes" },
        { key: "yes", label: "Yes again" },
      ],
    };
    expect(() => buildDeployPlan(bad)).toThrow(/unique/);
  });

  it("rejects a seed pool with an extra/misspelled key (phantom staked total)", () => {
    const btc = findDefinition("btc-150k-aug")!;
    const bad: MarketDefinition = {
      ...btc,
      seedPoolMotes: { ...btc.seedPoolMotes, maybe: "1" },
    };
    expect(() => buildDeployPlan(bad)).toThrow(/seedPoolMotes keys must be exactly/);
  });

  it("rejects a seed pool missing an outcome (zero-backed live outcome)", () => {
    const bad: MarketDefinition = {
      ...findDefinition("btc-150k-aug")!,
      seedPoolMotes: { yes: "1000" },
    };
    expect(() => buildDeployPlan(bad)).toThrow(/seedPoolMotes keys must be exactly/);
  });

  it("rejects a non-integer seed pool value", () => {
    const bad: MarketDefinition = {
      ...findDefinition("btc-150k-aug")!,
      seedPoolMotes: { yes: "1.5", no: "1000" },
    };
    expect(() => buildDeployPlan(bad)).toThrow(/non-negative integer motes/);
  });

  it("rejects an unparseable deadline", () => {
    const bad: MarketDefinition = { ...findDefinition("btc-150k-aug")!, deadlineIso: "not-a-date" };
    expect(() => buildDeployPlan(bad)).toThrow(/valid ISO date/);
  });

  it("rejects a threshold resolver missing its target/comparator", () => {
    const bad: MarketDefinition = {
      ...findDefinition("btc-150k-aug")!,
      resolver: { kind: "threshold", source: "coingecko", metric: "btc_usd", description: "x" },
    };
    expect(() => buildDeployPlan(bad)).toThrow(/threshold resolver requires/);
  });

  it("carries the house seed bets so a deploy escrows on-chain pools that match the catalogue", () => {
    for (const def of MARKET_DEFINITIONS) {
      expect(buildDeployPlan(def).seedBets).toEqual(def.seedPoolMotes);
    }
  });

  it("the whole catalogue generates without throwing (all configs are ABI-valid)", () => {
    expect(() => buildAllDeployPlans()).not.toThrow();
  });
});
