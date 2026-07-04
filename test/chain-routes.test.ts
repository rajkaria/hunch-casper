import { describe, it, expect, beforeEach } from "vitest";
import { POST as betPOST } from "@/app/api/chain/bet/route";
import { POST as resolvePOST } from "@/app/api/chain/resolve/route";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";

beforeEach(__resetLedger);

function post(handler: (req: Request) => Promise<Response>, url: string, body: unknown): Promise<Response> {
  return handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const BET_URL = "http://localhost/api/chain/bet";
const RESOLVE_URL = "http://localhost/api/chain/resolve";

describe("POST /api/chain/bet", () => {
  it("places a bet through the container and returns a deploy hash + explorer URL", async () => {
    const res = await post(betPOST, BET_URL, {
      network: "testnet",
      marketId: "testnet:coin-flip-5m",
      outcomeKey: "heads",
      amountMotes: "1000000000",
      bettor: "agent:momentum",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deployHash).toHaveLength(64);
    expect(json.explorerUrl).toContain("testnet.cspr.live/");
    expect(json.explorerUrl).toContain(json.deployHash);
  });

  it("is deterministic for identical input (mock adapter)", async () => {
    const body = {
      network: "testnet",
      marketId: "testnet:coin-flip-5m",
      outcomeKey: "heads",
      amountMotes: "5",
      bettor: "x",
    };
    const a = await (await post(betPOST, BET_URL, body)).json();
    const b = await (await post(betPOST, BET_URL, body)).json();
    expect(a.deployHash).toBe(b.deployHash);
  });

  it("records the bet into live pools", async () => {
    const res = await post(betPOST, BET_URL, {
      network: "testnet",
      marketId: "testnet:btc-150k-aug",
      outcomeKey: "yes",
      amountMotes: "1000000000000", // 1000 CSPR
      bettor: "agent:momentum",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    // seed yes=700 CSPR + 1000 CSPR bet = 1700 CSPR on yes.
    expect(json.poolByOutcomeMotes.yes).toBe("1700000000000");
  });

  it("rejects a bet on an unknown market or a bad outcome", async () => {
    const unknown = await post(betPOST, BET_URL, {
      network: "testnet",
      marketId: "testnet:not-a-market",
      outcomeKey: "yes",
      amountMotes: "5",
      bettor: "x",
    });
    expect(unknown.status).toBe(400);
    const badOutcome = await post(betPOST, BET_URL, {
      network: "testnet",
      marketId: "testnet:btc-150k-aug",
      outcomeKey: "maybe",
      amountMotes: "5",
      bettor: "x",
    });
    expect(badOutcome.status).toBe(400);
  });

  it("rejects an invalid network", async () => {
    const res = await post(betPOST, BET_URL, {
      network: "devnet",
      marketId: "m",
      outcomeKey: "yes",
      amountMotes: "5",
      bettor: "x",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive / non-integer stake", async () => {
    for (const amountMotes of ["0", "-1", "1.5", "abc", ""]) {
      const res = await post(betPOST, BET_URL, {
        network: "testnet",
        marketId: "m",
        outcomeKey: "yes",
        amountMotes,
        bettor: "x",
      });
      expect(res.status, `amountMotes=${amountMotes}`).toBe(400);
    }
  });

  it("enforces the mainnet bet cap (25 CSPR)", async () => {
    const over = await post(betPOST, BET_URL, {
      network: "mainnet",
      marketId: "m",
      outcomeKey: "yes",
      amountMotes: "26000000000", // 26 CSPR > 25 cap
      bettor: "x",
    });
    expect(over.status).toBe(400);

    const under = await post(betPOST, BET_URL, {
      network: "mainnet",
      marketId: "mainnet:btc-150k-aug",
      outcomeKey: "yes",
      amountMotes: "20000000000", // 20 CSPR
      bettor: "x",
    });
    expect(under.status).toBe(200);
  });

  it("rejects a malformed JSON body", async () => {
    const res = await post(betPOST, BET_URL, "{not json");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/chain/resolve", () => {
  it("resolves a market and returns the settlement manifest", async () => {
    const res = await post(resolvePOST, RESOLVE_URL, {
      network: "testnet",
      marketId: "testnet:coin-flip-5m",
      winningOutcomeKey: "tails",
      oracleId: "arbiter",
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deployHash).toHaveLength(64);
    expect(json.winningOutcomeKey).toBe("tails");
    expect(json.settlement.status).toBe("resolved");
    expect(json.settlement.manifest.winningOutcomeKey).toBe("tails");
  });

  it("defaults the oracle id to 'arbiter' when omitted", async () => {
    const res = await post(resolvePOST, RESOLVE_URL, {
      network: "testnet",
      marketId: "testnet:btc-150k-aug",
      winningOutcomeKey: "yes",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).oracleId).toBe("arbiter");
  });

  it("rejects a missing winning outcome", async () => {
    const res = await post(resolvePOST, RESOLVE_URL, {
      network: "testnet",
      marketId: "m",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an outcome that isn't part of the market", async () => {
    const res = await post(resolvePOST, RESOLVE_URL, {
      network: "testnet",
      marketId: "testnet:btc-150k-aug",
      winningOutcomeKey: "maybe",
    });
    expect(res.status).toBe(400);
  });

  it("is idempotent: a second resolve returns the first settlement, not a new one", async () => {
    const first = await (
      await post(resolvePOST, RESOLVE_URL, {
        network: "testnet",
        marketId: "testnet:btc-150k-aug",
        winningOutcomeKey: "yes",
      })
    ).json();
    expect(first.settlement.winningOutcomeKey).toBe("yes");

    // Re-resolve with a DIFFERENT winner — must not re-settle or echo the new winner.
    const second = await post(resolvePOST, RESOLVE_URL, {
      network: "testnet",
      marketId: "testnet:btc-150k-aug",
      winningOutcomeKey: "no",
    });
    expect(second.status).toBe(200);
    const json = await second.json();
    expect(json.alreadySettled).toBe(true);
    expect(json.winningOutcomeKey).toBe("yes"); // the first settlement stands
  });
});
