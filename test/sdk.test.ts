import { describe, it, expect, beforeEach } from "vitest";
import { HunchCasperClient } from "@/agent/sdk";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
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
    expect(markets.length).toBe(MARKET_DEFINITIONS.length);
    expect(markets.every((m) => m.network === "testnet")).toBe(true);
  });

  it("filters markets by category", async () => {
    const rwa = await client().listMarkets("rwa");
    // 5 live Nov-1 markets plus the 5 retired Aug-1 originals — retired markets stay on the board
    // as settled history, so discovery still lists them.
    expect(rwa.length).toBe(10);
    expect(rwa.every((m) => m.category === "rwa")).toBe(true);
  });

  it("gets a market and its odds", async () => {
    // btc-150k-aug matured on Aug 1; btc-70k-nov is its successor. Successors ship with empty
    // pools, so the odds this reads back are the ones we stake into it here.
    const c = client();
    await c.placeBet({
      marketId: "testnet:btc-70k-nov",
      outcomeKey: "yes",
      amountMotes: "1000000000",
      bettor: "agent:momentum",
    });
    await c.placeBet({
      marketId: "testnet:btc-70k-nov",
      outcomeKey: "no",
      amountMotes: "3000000000",
      bettor: "agent:contrarian",
    });

    const m = await c.getMarket("btc-70k-nov");
    expect(m?.slug).toBe("btc-70k-nov");
    const odds = await c.getOdds("btc-70k-nov");
    expect(odds.reduce((s, o) => s + o.impliedProbability, 0)).toBeCloseTo(1, 6);
    expect(odds.find((o) => o.outcomeKey === "yes")?.impliedProbability).toBeCloseTo(0.25, 6);
  });

  it("reads the oracle reputation", async () => {
    const rep = await client().oracleReputation();
    expect(rep.name).toBe("Arbiter");
    expect(rep.accuracyBps).toBe(9609);
  });

  it("places a bet end-to-end through the x402 exchange", async () => {
    const c = client();
    // The receipt must report the pool the bet joined, not just the bet. btc-70k-nov (successor to
    // the retired btc-150k-aug) opens empty, so stake the 700 CSPR of prior liquidity ourselves.
    await c.placeBet({
      marketId: "testnet:btc-70k-nov",
      outcomeKey: "yes",
      amountMotes: "700000000000",
      bettor: "agent:contrarian",
    });

    const receipt = await c.placeBet({
      marketId: "testnet:btc-70k-nov",
      outcomeKey: "yes",
      amountMotes: "2000000000",
      bettor: "agent:momentum",
    });
    expect(receipt.deployHash).toHaveLength(64);
    expect(receipt.indexed).toBe(true);
    expect(receipt.poolByOutcomeMotes?.yes).toBe("702000000000"); // 700 already staked + 2 CSPR
  });
});
