/**
 * Per-market on-chain routing, v1 + v2 aware. Legacy markets (the five pre-S16 deploys) each
 * live at their own ParimutuelMarket package, mapped by slug via `NEXT_PUBLIC_*_MARKET_ADDRS`
 * (JSON). Every other slug is a state entry inside the singleton HunchVault v2
 * (`NEXT_PUBLIC_*_VAULT_V2`) and its calls carry the slug as `market_id`. The legacy vault
 * (`NEXT_PUBLIC_*_VAULT`) stays the last fallback so a thin-slice deploy keeps working.
 * Pure + offline-tested — a mis-routed bet is a money bug.
 */

import { describe, it, expect } from "vitest";
import { parseMarketAddresses } from "@/config/network";
import { resolveMarketTarget } from "@/adapters/casper/deploy-plan";

const HASH_A = `hash-${"a".repeat(64)}`;
const HASH_B = `hash-${"b".repeat(64)}`;
const VAULT_V2 = `hash-${"c".repeat(64)}`;

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

describe("resolveMarketTarget", () => {
  const addresses = { "the-flip": HASH_A };

  it("routes a legacy market to its own deployed contract by slug — no market_id arg", () => {
    expect(
      resolveMarketTarget("testnet:the-flip", { marketAddresses: addresses, fallback: HASH_B }),
    ).toEqual({ contract: HASH_A });
  });

  it("legacy per-market map WINS over the v2 vault (pre-S16 deploys stay routable)", () => {
    expect(
      resolveMarketTarget("testnet:the-flip", {
        marketAddresses: addresses,
        vaultV2: VAULT_V2,
        fallback: HASH_B,
      }),
    ).toEqual({ contract: HASH_A });
  });

  it("routes unmapped markets to the v2 vault with the slug as the vault market id", () => {
    expect(
      resolveMarketTarget("testnet:btc-150k-aug1", {
        marketAddresses: addresses,
        vaultV2: VAULT_V2,
        fallback: HASH_B,
      }),
    ).toEqual({ contract: VAULT_V2, vaultMarketId: "btc-150k-aug1" });
  });

  it("falls back to the legacy vault when no v2 vault is configured (thin-slice deploy)", () => {
    expect(
      resolveMarketTarget("testnet:btc-150k-aug1", { marketAddresses: addresses, fallback: HASH_B }),
    ).toEqual({ contract: HASH_B });
  });

  it("accepts a bare slug (no network prefix) on both paths", () => {
    expect(resolveMarketTarget("the-flip", { marketAddresses: addresses, vaultV2: VAULT_V2 })).toEqual(
      { contract: HASH_A },
    );
    expect(resolveMarketTarget("prophet-race-weekly", { vaultV2: VAULT_V2 })).toEqual({
      contract: VAULT_V2,
      vaultMarketId: "prophet-race-weekly",
    });
  });

  it("throws when no mapping, v2 vault, or fallback exists", () => {
    expect(() => resolveMarketTarget("testnet:unmapped", { marketAddresses: {} })).toThrow(
      /no on-chain contract/i,
    );
  });
});
