/**
 * Fixture is a VERBATIM live CSPR.cloud `/deploys` response (testnet vault v2, captured
 * 2026-07-24) including a genuinely reverted call. Per AGENTS.md, an upstream parser is asserted
 * against the real payload — the `/auction-metrics` bug survived a green gate precisely because
 * its test mocked an invented shape.
 */

import { describe, expect, it, vi } from "vitest";
import {
  decodeDeployEvent,
  decodeDeployEvents,
  sortEvents,
  bareHash,
  createDeployEvents,
} from "@/adapters/casper/deploy-events";
import rows from "./fixtures/cspr-cloud-deploys.json";

const BET = rows[0];
const CREATE = rows[1];
const REVERTED = rows[2];

describe("decodeDeployEvent — live payloads", () => {
  it("folds a successful bet, with its market, outcome, stake and bettor", () => {
    const e = decodeDeployEvent(BET)!;
    expect(e.kind).toBe("bet_placed");
    expect(e.marketId).toBe("cspr-mcap-1b-aug");
    expect(e.outcomeKey).toBe("yes");
    expect(e.amountMotes).toBe("3000000000");
    expect(e.bettor).toBeTruthy();
    expect(e.blockHeight).toBe(8592429);
  });

  it("folds a market creation with its fee and outcomes", () => {
    const e = decodeDeployEvent(CREATE)!;
    expect(e.kind).toBe("market_created");
    expect(e.feeBps).toBe(200);
    expect(e.outcomeKeys).toEqual(["yes", "no"]);
  });

  it("NEVER folds a reverted call", () => {
    // This row really reverted on chain (ApiError::InvalidArgument [3]) — no money moved. Folding
    // it would put a stake on the boards that no vault is holding.
    expect(REVERTED.error_message).toBeTruthy();
    expect(decodeDeployEvent(REVERTED)).toBeNull();
  });

  it("drops rows with no mapped entry point", () => {
    expect(decodeDeployEvent({ ...BET, args: { ...BET.args, entry_point: { parsed: "admin" } } })).toBeNull();
  });

  it("drops rows missing an ordering key", () => {
    expect(decodeDeployEvent({ ...BET, block_height: undefined })).toBeNull();
    expect(decodeDeployEvent({ ...BET, deploy_hash: undefined })).toBeNull();
  });

  it("never throws on junk", () => {
    for (const junk of [null, undefined, 42, "x", [], {}]) {
      expect(() => decodeDeployEvent(junk)).not.toThrow();
      expect(decodeDeployEvent(junk)).toBeNull();
    }
  });

  it("decodes a whole page and skips the reverted row", () => {
    expect(decodeDeployEvents({ data: rows })).toHaveLength(2);
  });
});

describe("ordering", () => {
  it("sorts by block height, then deploy hash for a stable tie-break", () => {
    const events = sortEvents(decodeDeployEvents({ data: rows }));
    expect(events[0].blockHeight).toBeLessThan(events[1].blockHeight);
  });

  it("is a total order — equal heights never compare equal", () => {
    const base = decodeDeployEvent(BET)!;
    const sorted = sortEvents([
      { ...base, deployHash: "bbb" },
      { ...base, deployHash: "aaa" },
    ]);
    expect(sorted.map((e) => e.deployHash)).toEqual(["aaa", "bbb"]);
  });
});

describe("bareHash", () => {
  it("strips the hash- prefix the env map may or may not carry", () => {
    expect(bareHash("hash-abc")).toBe("abc");
    expect(bareHash("abc")).toBe("abc");
  });
});

describe("createDeployEvents — multiplexing", () => {
  function fetchStub() {
    return vi.fn(async (url: string) => {
      // Only the v1 package has anything; the point is that BOTH are read.
      const has = url.includes("v1package");
      return {
        ok: true,
        json: async () => ({ data: has ? [BET] : [] }),
      } as unknown as Response;
    });
  }

  it("reads EVERY routable contract, not just the vault", async () => {
    const fetchImpl = fetchStub();
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v1package", "hash-v2vault"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await port.fetch({ limit: 10 });
    const urls = fetchImpl.mock.calls.map((c) => c[0] as string);
    // The production defect: the vault was read and the five v1 packages were not.
    expect(urls.some((u) => u.includes("v1package"))).toBe(true);
    expect(urls.some((u) => u.includes("v2vault"))).toBe(true);
  });

  it("surfaces a v1 package's bets, which the vault-scoped stream could never see", async () => {
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v1package", "hash-v2vault"],
      fetchImpl: fetchStub() as unknown as typeof fetch,
    });
    const events = await port.fetch({ limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].marketId).toBe("cspr-mcap-1b-aug");
  });

  it("a failing contract read contributes nothing instead of blanking the board", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("bad")) throw new Error("network down");
      return { ok: true, json: async () => ({ data: [BET] }) } as unknown as Response;
    });
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-bad", "hash-good"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(port.fetch({ limit: 10 })).resolves.toHaveLength(1);
  });

  it("de-duplicates repeated contract hashes", async () => {
    const fetchImpl = fetchStub();
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v2vault", "v2vault", "hash-v2vault"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await port.fetch({ limit: 10 });
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it("honours fromBlockHeight", async () => {
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v1package"],
      fetchImpl: fetchStub() as unknown as typeof fetch,
    });
    expect(await port.fetch({ fromBlockHeight: 9_999_999 })).toEqual([]);
  });
});
