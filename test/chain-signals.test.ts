/**
 * Live chain signals for Genesis — the "watches CSPR.cloud" claim, made real. The adapter reads a
 * genuine chain datum with two sources and a safe order: CSPR.cloud validators (when an API key is
 * configured) → keyless node-RPC latest block height → null (caller falls back to the
 * deterministic demo rotation). Parsers are pure and defensive: a malformed upstream payload must
 * yield null, never a thrown 500 out of the Genesis route.
 */

import { describe, it, expect } from "vitest";
import {
  parseValidatorSignal,
  parseBlockHeightSignal,
  fetchLiveSignal,
} from "@/adapters/casper/chain-signals";

describe("parseValidatorSignal (CSPR.cloud)", () => {
  // Verbatim shape from GET https://api.testnet.cspr.cloud/auction-metrics (2026-07-18).
  const AUCTION_METRICS = {
    data: {
      current_era_id: 22988,
      active_validator_number: 83,
      total_bids_number: 18546,
      active_bids_number: 83,
      total_active_era_stake: "355134116068779222",
    },
  };

  it("reads the active validator count from /auction-metrics", () => {
    expect(parseValidatorSignal(AUCTION_METRICS)).toEqual({
      metric: "active_validators",
      value: "83",
      unitLabel: "",
      sourceLabel: "CSPR.cloud",
    });
  });

  it("returns null for payloads without a usable count", () => {
    expect(parseValidatorSignal({ data: {} })).toBeNull();
    expect(parseValidatorSignal(null)).toBeNull();
    expect(parseValidatorSignal({ data: { active_validator_number: "many" } })).toBeNull();
    // The pre-2026-07-18 `/validators?page=1&page_size=1` shape. That endpoint 400s without an
    // `era_id`, so this payload never actually arrives — it must not be mistaken for a signal.
    expect(parseValidatorSignal({ data: [], item_count: 142 })).toBeNull();
  });
});

describe("parseBlockHeightSignal (node RPC)", () => {
  it("reads a Casper 2.0 block height", () => {
    const rpc = {
      result: { block_with_signatures: { block: { Version2: { header: { height: 3400123 } } } } },
    };
    expect(parseBlockHeightSignal(rpc)).toEqual({
      metric: "latest_block_height",
      value: "3400123",
      unitLabel: "",
      sourceLabel: "Casper RPC",
    });
  });

  it("reads a legacy block height", () => {
    const rpc = { result: { block: { header: { height: 1234 } } } };
    expect(parseBlockHeightSignal(rpc)).toEqual({
      metric: "latest_block_height",
      value: "1234",
      unitLabel: "",
      sourceLabel: "Casper RPC",
    });
  });

  it("returns null on malformed payloads", () => {
    expect(parseBlockHeightSignal({})).toBeNull();
    expect(parseBlockHeightSignal(undefined)).toBeNull();
    expect(parseBlockHeightSignal({ result: { block: { header: { height: "x" } } } })).toBeNull();
  });
});

describe("fetchLiveSignal", () => {
  it("prefers CSPR.cloud when an API key is present", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: { active_validator_number: 98 } }), {
        status: 200,
      });
    };
    const signal = await fetchLiveSignal("testnet", { apiKey: "k", fetchImpl });
    expect(signal).toEqual({
      metric: "active_validators",
      value: "98",
      unitLabel: "",
      sourceLabel: "CSPR.cloud",
    });
    // Regression: `/validators` without an `era_id` 400s, which silently demoted every keyed
    // request to the RPC fallback. Pin the endpoint that actually answers.
    expect(calls[0]).toContain("/auction-metrics");
    expect(calls[0]).toContain("cspr.cloud");
  });

  it("falls back to node RPC when CSPR.cloud rejects the request", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("cspr.cloud")) {
        return new Response(JSON.stringify({ error: { code: "invalid_input" } }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          result: { block_with_signatures: { block: { Version2: { header: { height: 77 } } } } },
        }),
        { status: 200 },
      );
    };
    const signal = await fetchLiveSignal("testnet", { apiKey: "k", fetchImpl });
    expect(signal?.metric).toBe("latest_block_height");
    expect(signal?.sourceLabel).toBe("Casper RPC");
  });

  it("falls back to node RPC block height without a key", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      expect(String(url)).toContain("/rpc");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { block_with_signatures: { block: { Version2: { header: { height: 42 } } } } },
        }),
        { status: 200 },
      );
    };
    const signal = await fetchLiveSignal("testnet", { fetchImpl });
    expect(signal?.metric).toBe("latest_block_height");
    expect(signal?.value).toBe("42");
  });

  it("returns null when every source fails (caller uses the demo rotation)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network down");
    };
    expect(await fetchLiveSignal("testnet", { apiKey: "k", fetchImpl })).toBeNull();
  });
});

describe("Genesis trigger provenance", () => {
  it("stamps the market subtitle with the signal's source label", async () => {
    const { definitionFromTrigger } = await import("@/agent/genesis");
    const def = definitionFromTrigger(
      {
        metric: "latest_block_height",
        value: "3400123",
        unitLabel: "",
        deadlineIso: new Date(1900000000000).toISOString(),
        seq: 0,
        sourceLabel: "Casper RPC",
      },
      "",
    );
    expect(def.subtitle).toContain("Casper RPC");
    expect(def.subtitle).not.toContain("CSPR.cloud");
  });

  it("defaults the source label to CSPR.cloud", async () => {
    const { definitionFromTrigger } = await import("@/agent/genesis");
    const def = definitionFromTrigger(
      {
        metric: "cspr_usd",
        value: "0.05",
        unitLabel: "$",
        deadlineIso: new Date(1900000000000).toISOString(),
        seq: 0,
      },
      "",
    );
    expect(def.subtitle).toContain("CSPR.cloud");
  });
});
