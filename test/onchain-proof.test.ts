/**
 * The on-chain proof surface: once the ops deploy wires real contract package hashes (env) and
 * receipt tx hashes (NEXT_PUBLIC_ONCHAIN_RECEIPTS), the landing/docs render real explorer links —
 * contracts at /contract-package/<hash>, transactions at /transaction/<hash>. Credential-free
 * deploys render nothing (the section hides), so the proof is never fabricated.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { onchainProof, parseReceipts } from "@/config/onchain-proof";
import { getNetworkConfig } from "@/config/network";

afterEach(() => vi.unstubAllEnvs());

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("onchainProof", () => {
  it("is empty when no contracts or receipts are configured", () => {
    const proof = onchainProof("testnet", {
      ...getNetworkConfig("testnet"),
      contracts: {},
    });
    expect(proof.contracts).toEqual([]);
    expect(proof.receipts).toEqual([]);
    expect(proof.hasAny).toBe(false);
  });

  it("builds contract-package explorer links from wired addresses", () => {
    const proof = onchainProof("testnet", {
      ...getNetworkConfig("testnet"),
      contracts: { marketFactory: `hash-${HASH_A}`, vault: HASH_B },
    });
    expect(proof.hasAny).toBe(true);
    expect(proof.contracts).toEqual([
      {
        label: "MarketFactory",
        hash: `hash-${HASH_A}`,
        url: `https://testnet.cspr.live/contract-package/${HASH_A}`,
      },
      {
        label: "ParimutuelMarket (vault)",
        hash: HASH_B,
        url: `https://testnet.cspr.live/contract-package/${HASH_B}`,
      },
    ]);
  });

  it("renders per-market catalogue packages after the singletons, sorted by slug", () => {
    const proof = onchainProof("testnet", {
      ...getNetworkConfig("testnet"),
      contracts: { marketFactory: `hash-${HASH_A}` },
      marketAddresses: {
        "cspr-price-05-aug": `contract-package-${HASH_B}`,
        "btc-150k-aug": `hash-${HASH_A}`,
      },
    });
    expect(proof.contracts.map((c) => c.label)).toEqual([
      "MarketFactory",
      "ParimutuelMarket — btc-150k-aug",
      "ParimutuelMarket — cspr-price-05-aug",
    ]);
    expect(proof.contracts[1].url).toBe(`https://testnet.cspr.live/contract-package/${HASH_A}`);
    expect(proof.contracts[2].url).toBe(`https://testnet.cspr.live/contract-package/${HASH_B}`);
  });

  it("parses receipts from env JSON, filters to the network, and skips malformed entries", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_ONCHAIN_RECEIPTS",
      JSON.stringify([
        { label: "First real bet", hash: HASH_A, network: "testnet" },
        { label: "Mainnet-only", hash: HASH_B, network: "mainnet" },
        { label: "bad hash", hash: "nope", network: "testnet" },
        { label: 42, hash: HASH_B, network: "testnet" },
      ]),
    );
    const receipts = parseReceipts("testnet");
    expect(receipts).toEqual([
      {
        label: "First real bet",
        hash: HASH_A,
        url: `https://testnet.cspr.live/transaction/${HASH_A}`,
      },
    ]);
  });

  it("treats invalid receipts JSON as no receipts", () => {
    vi.stubEnv("NEXT_PUBLIC_ONCHAIN_RECEIPTS", "{not json");
    expect(parseReceipts("testnet")).toEqual([]);
  });
});
