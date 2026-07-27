/**
 * `POST /api/chain/bet/confirm` as a POLL rather than a wait.
 *
 * The route used to block until the transaction executed — 8-16s on testnet, up to 150s — and the
 * bet panel rendered nothing until it answered. The visitor's own transaction hash, final and
 * known from the moment `prepare` built it, was invisible for the whole of that. Now each call is
 * one read and one answer and the client polls, so the receipt is on screen immediately.
 *
 * What has to stay true, and is what this file pins:
 *
 *   • a bet is indexed ONLY on an execution the chain actually reports — pending and reverted move
 *     no money on the boards;
 *   • polling is safe. The same executed transaction is now observed by several requests, and each
 *     one must not add the stake again: at-most-once on the transaction hash.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TransactionStatus } from "@/ports/casper-chain";

/**
 * The mock chain deliberately cannot confirm someone else's transaction (a simulated chain has no
 * external transactions), so the polling path needs a chain that can. Everything else — the store,
 * the ledger, the persistence — stays real, because the dedupe claim is only worth testing against
 * the real one.
 */
let nextStatus: TransactionStatus = { status: "pending" };

vi.mock("@/lib/container", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/container")>();
  return {
    ...actual,
    createContainer: (network?: "testnet" | "mainnet") => {
      const container = actual.createContainer(network);
      return {
        ...container,
        chain: {
          ...container.chain,
          checkTransaction: async (): Promise<TransactionStatus> => nextStatus,
        },
      };
    },
  };
});

const { POST: confirmPOST } = await import("@/app/api/chain/bet/confirm/route");
const { GET: marketsGET } = await import("@/app/api/markets/route");
const { signBetTicket } = await import("@/lib/bet-ticket");
const { __resetLedger } = await import("@/adapters/mock/settlement-ledger");

const SECRET = "test-bet-ticket-secret";
const STAKE = "300000000000"; // 300 CSPR

async function anOpenMarket(): Promise<{ id: string; outcomeKey: string; poolMotes: string }> {
  const res = await marketsGET(new Request("http://localhost/api/markets?network=testnet"));
  const json = await res.json();
  const market = json.markets.find((m: { status: string }) => m.status === "open");
  if (!market) throw new Error("fixture has no open market");
  return {
    id: market.id,
    outcomeKey: market.outcomes[0].key,
    poolMotes: market.poolByOutcomeMotes[market.outcomes[0].key],
  };
}

function ticketFor(market: { id: string; outcomeKey: string }, transactionHash: string): string {
  return signBetTicket(
    {
      network: "testnet",
      marketId: market.id,
      outcomeKey: market.outcomeKey,
      amountMotes: STAKE,
      bettor: "01aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      transactionHash,
      issuedAtMs: Date.now(),
      custody: "self",
    },
    SECRET,
  );
}

function confirm(ticket: string) {
  return confirmPOST(
    new Request("http://localhost/api/chain/bet/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    }),
  );
}

beforeEach(() => {
  __resetLedger();
  vi.stubEnv("BET_TICKET_SECRET", SECRET);
  nextStatus = { status: "pending" };
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/chain/bet/confirm — polling", () => {
  it("answers pending with a usable receipt instead of blocking until execution", async () => {
    const market = await anOpenMarket();
    const hash = "aa".repeat(32);

    const res = await confirm(ticketFor(market, hash));
    const json = await res.json();

    // 200, not an error: nothing is wrong, the chain just has not executed it yet.
    expect(res.status).toBe(200);
    expect(json.status).toBe("pending");
    // The receipt is the whole point — a hash and a link the visitor can follow RIGHT NOW.
    expect(json.deployHash).toBe(hash);
    expect(json.explorerUrl).toContain(hash);

    // And nothing has been staked: a queued transaction is not a bet.
    const after = await anOpenMarket();
    expect(after.poolMotes).toBe(market.poolMotes);
  });

  it("indexes the bet once the chain reports it executed, and moves the pools", async () => {
    const market = await anOpenMarket();
    nextStatus = {
      status: "confirmed",
      result: { deployHash: "bb".repeat(32), explorerUrl: "https://testnet.cspr.live/tx/bb" },
    };

    const json = await (await confirm(ticketFor(market, "bb".repeat(32)))).json();
    expect(json.status).toBe("confirmed");
    expect(json.indexed).toBe(true);
    expect(BigInt(json.poolByOutcomeMotes[market.outcomeKey])).toBe(
      BigInt(market.poolMotes) + BigInt(STAKE),
    );
  });

  it("stakes ONE bet however many times the client polls the same transaction", async () => {
    // The hazard the poll introduced: two in-flight polls (or a retry) both see the same success.
    // One transaction is one bet — the boards must never claim money the vault took once.
    const market = await anOpenMarket();
    const hash = "cc".repeat(32);
    const ticket = ticketFor(market, hash);

    nextStatus = { status: "pending" };
    await confirm(ticket);

    nextStatus = {
      status: "confirmed",
      result: { deployHash: hash, explorerUrl: `https://testnet.cspr.live/tx/${hash}` },
    };
    const first = await (await confirm(ticket)).json();
    const second = await (await confirm(ticket)).json();
    const third = await (await confirm(ticket)).json();

    const expected = (BigInt(market.poolMotes) + BigInt(STAKE)).toString();
    for (const answer of [first, second, third]) {
      expect(answer.status).toBe("confirmed");
      expect(answer.poolByOutcomeMotes[market.outcomeKey]).toBe(expected);
    }
    const after = await anOpenMarket();
    expect(after.poolMotes).toBe(expected);
  });

  it("reports a revert as reverted and stakes nothing", async () => {
    const market = await anOpenMarket();
    nextStatus = { status: "reverted", error: "User error: 19" };

    const json = await (await confirm(ticketFor(market, "dd".repeat(32)))).json();
    expect(json.status).toBe("reverted");
    expect(json.error).toMatch(/User error: 19/);
    expect(json.indexed).toBeUndefined();

    const after = await anOpenMarket();
    expect(after.poolMotes).toBe(market.poolMotes);
  });

  it("still refuses a ticket it did not sign, however the chain answers", async () => {
    // Making confirmation pollable must not have opened the terms up: a caller can ask about any
    // hash they like, but only a ticket this server minted says what the bet was.
    nextStatus = {
      status: "confirmed",
      result: { deployHash: "ee".repeat(32), explorerUrl: "https://testnet.cspr.live/tx/ee" },
    };
    const market = await anOpenMarket();
    const forged = signBetTicket(
      {
        network: "testnet",
        marketId: market.id,
        outcomeKey: market.outcomeKey,
        amountMotes: "99999000000000",
        bettor: "01aa",
        transactionHash: "ee".repeat(32),
        issuedAtMs: Date.now(),
      },
      "not-the-server-secret",
    );
    const res = await confirm(forged);
    expect(res.status).toBe(400);
    const after = await anOpenMarket();
    expect(after.poolMotes).toBe(market.poolMotes);
  });
});
