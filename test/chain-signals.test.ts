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
  it("reads the validator count from item_count", () => {
    expect(parseValidatorSignal({ data: [], item_count: 142 })).toEqual({
      metric: "active_validators",
      value: "142",
      unitLabel: "",
      sourceLabel: "CSPR.cloud",
    });
  });

  it("returns null for payloads without a usable count", () => {
    expect(parseValidatorSignal({ data: [] })).toBeNull();
    expect(parseValidatorSignal(null)).toBeNull();
    expect(parseValidatorSignal({ item_count: "many" })).toBeNull();
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
      return new Response(JSON.stringify({ data: [], item_count: 98 }), { status: 200 });
    };
    const signal = await fetchLiveSignal("testnet", { apiKey: "k", fetchImpl });
    expect(signal).toEqual({
      metric: "active_validators",
      value: "98",
      unitLabel: "",
      sourceLabel: "CSPR.cloud",
    });
    expect(calls[0]).toContain("cspr.cloud");
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
