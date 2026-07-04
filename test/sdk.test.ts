import { describe, it, expect, beforeEach } from "vitest";
import { HunchCasperClient } from "@/agent/sdk";
import { GET as marketsGET } from "@/app/api/markets/route";
import { GET as marketGET } from "@/app/api/markets/[slug]/route";
import { GET as oracleGET } from "@/app/api/oracle/[id]/route";
import { POST as betPOST } from "@/app/api/agent/v1/bet/route";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";

beforeEach(() => {
  __resetLedger();
  __resetConsumedNonces();
});

/** In-process fetch that dispatches straight to the real route handlers (no server). */
const dispatch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input as Request).url;
  const u = new URL(url, "http://localhost");
  const req = new Request(u.toString(), init as RequestInit);
  if (u.pathname === "/api/markets") return marketsGET(req);
  if (u.pathname.startsWith("/api/markets/")) {
    const slug = u.pathname.slice("/api/markets/".length);
    return marketGET(req, { params: Promise.resolve({ slug }) });
  }
  if (u.pathname.startsWith("/api/oracle/")) {
    const id = u.pathname.slice("/api/oracle/".length);
    return oracleGET(req, { params: Promise.resolve({ id }) });
  }
  if (u.pathname === "/api/agent/v1/bet") return betPOST(req);
  throw new Error(`no route for ${u.pathname}`);
};

function client() {
  return new HunchCasperClient({ fetchImpl: dispatch, network: "testnet" });
}

describe("Agent SDK", () => {
  it("discovers markets", async () => {
    const markets = await client().listMarkets();
    expect(markets.length).toBe(16);
    expect(markets.every((m) => m.network === "testnet")).toBe(true);
  });

  it("filters markets by category", async () => {
    const rwa = await client().listMarkets("rwa");
    expect(rwa.length).toBe(5);
  });

  it("gets a market and its odds", async () => {
    const m = await client().getMarket("btc-150k-aug");
    expect(m?.slug).toBe("btc-150k-aug");
    const odds = await client().getOdds("btc-150k-aug");
    expect(odds.reduce((s, o) => s + o.impliedProbability, 0)).toBeCloseTo(1, 6);
  });

  it("reads the oracle reputation", async () => {
    const rep = await client().oracleReputation();
    expect(rep.name).toBe("Arbiter");
    expect(rep.accuracyBps).toBe(9609);
  });

  it("places a bet end-to-end through the x402 exchange", async () => {
    const receipt = await client().placeBet({
      marketId: "testnet:btc-150k-aug",
      outcomeKey: "yes",
      amountMotes: "2000000000",
      bettor: "agent:momentum",
    });
    expect(receipt.deployHash).toHaveLength(64);
    expect(receipt.indexed).toBe(true);
    expect(receipt.poolByOutcomeMotes?.yes).toBe("702000000000"); // seed 700 + 2 CSPR
  });
});
