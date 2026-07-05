/**
 * Per-market on-chain routing: the full catalogue deploys one ParimutuelMarket contract per
 * market (the S11 manifest), so the real adapter must target the RIGHT package hash per bet or
 * resolve — not funnel everything into the single `NEXT_PUBLIC_*_VAULT` contract. The slug→hash
 * map arrives via `NEXT_PUBLIC_*_MARKET_ADDRS` (JSON); the vault stays the fallback so a
 * single-contract thin-slice deploy keeps working.
 */

import { describe, it, expect } from "vitest";
import { parseMarketAddresses } from "@/config/network";
import { resolveMarketContract } from "@/adapters/casper/deploy-plan";

const HASH_A = `hash-${"a".repeat(64)}`;
const HASH_B = `hash-${"b".repeat(64)}`;

describe("parseMarketAddresses", () => {
  it("parses a slug→package-hash JSON object", () => {
    const raw = JSON.stringify({ "cspr-above-5c-aug1": HASH_A, "the-flip": HASH_B });
    expect(parseMarketAddresses(raw)).toEqual({
      "cspr-above-5c-aug1": HASH_A,
      "the-flip": HASH_B,
    });
  });

  it("returns {} for unset, invalid JSON, or non-object payloads", () => {
    expect(parseMarketAddresses(undefined)).toEqual({});
    expect(parseMarketAddresses("")).toEqual({});
    expect(parseMarketAddresses("{oops")).toEqual({});
    expect(parseMarketAddresses('["a"]')).toEqual({});
  });

  it("drops entries whose value is not a contract hash string", () => {
    const raw = JSON.stringify({ good: HASH_A, bad: 42, worse: "not-a-hash" });
    expect(parseMarketAddresses(raw)).toEqual({ good: HASH_A });
  });
});

describe("resolveMarketContract", () => {
  const addresses = { "the-flip": HASH_A };

  it("routes a market to its own deployed contract by slug", () => {
    expect(
      resolveMarketContract("testnet:the-flip", { marketAddresses: addresses, fallback: HASH_B }),
    ).toBe(HASH_A);
  });

  it("falls back to the vault for unmapped markets (thin-slice deploy)", () => {
    expect(
      resolveMarketContract("testnet:btc-150k-aug1", { marketAddresses: addresses, fallback: HASH_B }),
    ).toBe(HASH_B);
  });

  it("accepts a bare slug (no network prefix)", () => {
    expect(resolveMarketContract("the-flip", { marketAddresses: addresses, fallback: HASH_B })).toBe(
      HASH_A,
    );
  });

  it("throws when neither a mapping nor a fallback exists", () => {
    expect(() => resolveMarketContract("testnet:unmapped", { marketAddresses: {} })).toThrow(
      /no on-chain contract/i,
    );
  });
});
