import { describe, it, expect } from "vitest";
import { buildDeployManifest } from "@/core/deploy-manifest";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { NETWORKS } from "@/config/network";

/**
 * The S11 "deploy all contracts + the full catalogue to mainnet" invariant, made testable
 * without a funded key: the manifest must describe the whole catalogue + both infra contracts,
 * be identical across networks (same contracts, both networks — the toggle's core promise), and
 * carry each network's real-money guardrails so the deploy driver + runbook stay honest.
 */
describe("buildDeployManifest", () => {
  it("covers the full catalogue on both networks", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      const m = buildDeployManifest(network);
      expect(m.marketCount).toBe(MARKET_DEFINITIONS.length);
      expect(m.markets.length).toBe(MARKET_DEFINITIONS.length);
      expect(m.markets.length).toBeGreaterThanOrEqual(15);
    }
  });

  it("deploys BOTH singleton infra contracts (factory + oracle registry)", () => {
    const infra = buildDeployManifest("mainnet").infrastructure.map((c) => c.contract);
    expect(infra).toContain("MarketFactory");
    expect(infra).toContain("OracleRegistry");
  });

  it("is address-free: the market deploy plans are byte-identical across networks", () => {
    // Same contracts deploy to both Casper networks — only the target + guardrails differ.
    const testnet = buildDeployManifest("testnet");
    const mainnet = buildDeployManifest("mainnet");
    expect(JSON.stringify(mainnet.markets)).toBe(JSON.stringify(testnet.markets));
  });

  it("carries the correct deploy target + guardrails per network", () => {
    const testnet = buildDeployManifest("testnet");
    const mainnet = buildDeployManifest("mainnet");

    expect(testnet.chainName).toBe("casper-test");
    expect(mainnet.chainName).toBe("casper");

    // Mainnet: capped + disclosed. Testnet: unconstrained.
    expect(mainnet.guardrails.maxBetCspr).toBe(NETWORKS.mainnet.guardrails.maxBetCspr);
    expect(mainnet.guardrails.showUnauditedBanner).toBe(true);
    expect(testnet.guardrails.maxBetCspr).toBeNull();
    expect(testnet.guardrails.showUnauditedBanner).toBe(false);
  });

  it("gives every market a deployable, self-consistent plan", () => {
    for (const plan of buildDeployManifest("mainnet").markets) {
      expect(plan.init.outcomeKeys.length).toBeGreaterThanOrEqual(2);
      expect(plan.init.feeBps).toBeGreaterThanOrEqual(0);
      expect(plan.init.feeBps).toBeLessThan(10_000);
      expect(plan.init.deadlineMs).toBeGreaterThan(0);
      expect(plan.registration.id).toBe(plan.slug);
      // Seed liquidity backs exactly the outcomes — no missing/phantom key.
      expect(Object.keys(plan.seedBets).sort()).toEqual([...plan.init.outcomeKeys].sort());
    }
  });
});
