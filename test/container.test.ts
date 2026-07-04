import { describe, it, expect } from "vitest";
import { createContainer } from "@/lib/container";

describe("container (mock wiring)", () => {
  it("wires the selected network end to end", () => {
    const c = createContainer("mainnet");
    expect(c.network).toBe("mainnet");
    expect(c.chain.network).toBe("mainnet");
  });

  it("places a bet returning a 64-char deploy hash + explorer URL", async () => {
    const c = createContainer("testnet");
    const res = await c.chain.placeBet({
      marketId: "testnet:coin-flip-5m",
      outcomeKey: "heads",
      amountMotes: "1000000000",
      bettor: "agent:momentum",
    });
    expect(res.deployHash).toHaveLength(64);
    expect(res.explorerUrl).toContain("testnet.cspr.live/transaction/");
  });

  it("is deterministic — identical bet yields identical hash", async () => {
    const input = { marketId: "m", outcomeKey: "yes", amountMotes: "5", bettor: "x" };
    const a = await createContainer("testnet").chain.placeBet(input);
    const b = await createContainer("testnet").chain.placeBet(input);
    expect(a.deployHash).toBe(b.deployHash);
  });

  it("round-trips an x402 quote → settle → verify", async () => {
    const c = createContainer("testnet");
    const req = await c.payment.quote({
      marketId: "m",
      outcomeKey: "yes",
      amountMotes: "1000000000",
      payer: "agent:value",
    });
    const proof = await c.payment.settle(req, "agent:value");
    expect(proof.scheme).toBe("casper-x402");
    expect(await c.payment.verify(req, proof)).toBe(true);
  });

  it("rejects a proof with a mismatched nonce", async () => {
    const c = createContainer("testnet");
    const req = await c.payment.quote({ marketId: "m", outcomeKey: "yes", amountMotes: "1", payer: "agent:value" });
    const proof = await c.payment.settle(req, "agent:value");
    expect(await c.payment.verify({ ...req, nonce: "tampered" }, proof)).toBe(false);
  });

  it("resolves an oracle reading deterministically to a valid outcome", async () => {
    const c = createContainer("testnet");
    const r1 = await c.oracle.read("testnet:coin-flip-5m");
    const r2 = await c.oracle.read("testnet:coin-flip-5m");
    expect(r1.winningOutcomeKey).toBe(r2.winningOutcomeKey);
    expect(["heads", "tails", "tie"]).toContain(r1.winningOutcomeKey);
  });
});
