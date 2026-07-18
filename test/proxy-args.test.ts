import { describe, it, expect } from "vitest";
import { buildBetPlan } from "@/adapters/casper/deploy-plan";
import { buildBetProxyArgs, toHexHash, hexToBytes } from "@/adapters/casper/real-chain";

const PKG = `hash-${"ab".repeat(32)}`; // hash- + 64 hex

describe("buildBetProxyArgs (Odra proxy envelope — money-path invariant)", () => {
  const plan = buildBetPlan(
    { marketId: "testnet:coin-flip-5m", outcomeKey: "heads", amountMotes: "2500000000", bettor: "demo:human" },
    { marketContract: PKG },
  );
  const args = buildBetProxyArgs(plan);

  it("carries EXACTLY the five proxy args Odra expects (rename/reorder = zero-value bug)", () => {
    expect([...args.args.keys()].sort()).toEqual([
      "amount",
      "args",
      "attached_value",
      "entry_point",
      "package_hash",
    ]);
  });

  it("targets the `bet` entry point", () => {
    expect(args.getByName("entry_point")!.toString()).toBe("bet");
  });

  it("attaches the stake as attached_value AND amount, EQUAL (a mismatch is a money bug)", () => {
    const attached = args.getByName("attached_value")!.toString();
    const amount = args.getByName("amount")!.toString();
    expect(attached).toBe(amount);
    expect(attached).toBe("2500000000");
  });

  it("passes the target contract as its 32-byte package hash", () => {
    const bytes = args.getByName("package_hash")!.byteArray!.bytes();
    expect(bytes.length).toBe(32);
    expect([...bytes]).toEqual([...hexToBytes(toHexHash(PKG))]);
  });

  it("serializes the inner entry-point args (outcome) into the args bytes", () => {
    const bytes = args.getByName("args")!.byteArray!.bytes();
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("a v2 vault bet keeps the SAME 5-arg envelope, with market_id inside the inner args", () => {
    const v2Plan = buildBetPlan(
      { marketId: "testnet:btc-150k-aug1", outcomeKey: "heads", amountMotes: "2500000000", bettor: "demo:human" },
      { marketContract: PKG, vaultMarketId: "btc-150k-aug1" },
    );
    const v2Args = buildBetProxyArgs(v2Plan);
    expect([...v2Args.args.keys()].sort()).toEqual([
      "amount",
      "args",
      "attached_value",
      "entry_point",
      "package_hash",
    ]);
    // The extra market_id arg rides INSIDE the serialized inner args, not the envelope.
    const v1Bytes = args.getByName("args")!.byteArray!.bytes();
    const v2Bytes = v2Args.getByName("args")!.byteArray!.bytes();
    expect(v2Bytes.length).toBeGreaterThan(v1Bytes.length);
    expect(v2Args.getByName("entry_point")!.toString()).toBe("bet");
  });
});

describe("toHexHash / hexToBytes", () => {
  it("strips the hash- prefix and lowercases to 64 hex", () => {
    expect(toHexHash(`hash-${"AB".repeat(32)}`)).toBe("ab".repeat(32));
  });

  it("rejects wrong-length or non-hex input", () => {
    expect(() => toHexHash("hash-1234")).toThrow(/32-byte hex/);
    expect(() => toHexHash("nothex")).toThrow(/32-byte hex/);
  });

  it("hexToBytes round-trips 32 bytes", () => {
    const b = hexToBytes("ab".repeat(32));
    expect(b.length).toBe(32);
    expect(b[0]).toBe(0xab);
  });
});
