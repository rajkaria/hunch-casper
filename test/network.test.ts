import { describe, it, expect } from "vitest";
import {
  CASPER_NETWORKS,
  NETWORKS,
  explorerTransactionUrl,
  isCasperNetwork,
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
});
