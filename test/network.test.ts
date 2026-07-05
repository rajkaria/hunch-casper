import { describe, it, expect } from "vitest";
import {
  CASPER_NETWORKS,
  NETWORKS,
  exceedsBetCap,
  explorerTransactionUrl,
  isCasperNetwork,
  maxBetCspr,
} from "@/config/network";

describe("network config", () => {
  it("defines exactly the two Casper networks", () => {
    expect([...CASPER_NETWORKS]).toEqual(["testnet", "mainnet"]);
  });

  it("uses the correct chain names for signing", () => {
    expect(NETWORKS.testnet.chainName).toBe("casper-test");
    expect(NETWORKS.mainnet.chainName).toBe("casper");
  });

  it("builds per-network explorer transaction URLs (Casper 2.0 /transaction/ path)", () => {
    expect(explorerTransactionUrl("testnet", "abc")).toBe("https://testnet.cspr.live/transaction/abc");
    expect(explorerTransactionUrl("mainnet", "abc")).toBe("https://cspr.live/transaction/abc");
  });

  it("caps mainnet bets and discloses; testnet is uncapped", () => {
    expect(NETWORKS.mainnet.guardrails.maxBetCspr).toBeGreaterThan(0);
    expect(NETWORKS.mainnet.guardrails.showUnauditedBanner).toBe(true);
    expect(NETWORKS.testnet.guardrails.maxBetCspr).toBeNull();
    expect(NETWORKS.testnet.guardrails.showUnauditedBanner).toBe(false);
  });

  it("validates network strings", () => {
    expect(isCasperNetwork("testnet")).toBe(true);
    expect(isCasperNetwork("mainnet")).toBe(true);
    expect(isCasperNetwork("l2")).toBe(false);
    expect(isCasperNetwork(null)).toBe(false);
  });

  it("exposes the mainnet cap as a shared helper (one source for every surface)", () => {
    expect(maxBetCspr("testnet")).toBeNull();
    expect(maxBetCspr("mainnet")).toBe(NETWORKS.mainnet.guardrails.maxBetCspr);
  });

  it("enforces the per-bet cap only on mainnet, at the boundary", () => {
    const cap = NETWORKS.mainnet.guardrails.maxBetCspr!;
    expect(exceedsBetCap("mainnet", cap)).toBe(false); // exactly at the cap is allowed
    expect(exceedsBetCap("mainnet", cap + 0.0001)).toBe(true);
    expect(exceedsBetCap("mainnet", cap * 4)).toBe(true);
    // Testnet is uncapped — no amount is ever over the cap.
    expect(exceedsBetCap("testnet", cap * 1000)).toBe(false);
  });
});
