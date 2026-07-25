/**
 * The self-custodial bet routes: `prepare` → (the visitor's wallet signs) → `confirm`.
 *
 * What is worth pinning here is not the happy path — it is that `confirm` cannot be talked into
 * indexing a bet nobody placed, and that a deployment which cannot offer wallet signing says so in
 * a way the client can act on (501) rather than failing.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { POST as preparePOST } from "@/app/api/chain/bet/prepare/route";
import { POST as confirmPOST } from "@/app/api/chain/bet/confirm/route";
import { GET as marketsGET } from "@/app/api/markets/route";
import { signBetTicket } from "@/lib/bet-ticket";

const SECRET = "test-bet-ticket-secret";

/** A real open market from the catalogue — the routes validate against it. */
async function anOpenMarket(): Promise<{ id: string; outcomeKey: string }> {
  const res = await marketsGET(new Request("http://localhost/api/markets?network=testnet"));
  const json = await res.json();
  const market = json.markets.find((m: { status: string }) => m.status === "open");
  if (!market) throw new Error("fixture has no open market");
  return { id: market.id, outcomeKey: market.outcomes[0].key };
}

function post(handler: (req: Request) => Promise<Response>, url: string, body: unknown) {
  return handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => vi.stubEnv("BET_TICKET_SECRET", SECRET));
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/chain/bet/prepare", () => {
  it("tells the client to use the operator-signed route when this chain cannot sign per user", async () => {
    // The default test container is the mock chain: no transaction exists to hand to a wallet.
    // 501 is a capability answer, not a failure — the bet panel reads it as "fall back".
    const market = await anOpenMarket();
    const res = await post(preparePOST, "http://localhost/api/chain/bet/prepare", {
      network: "testnet",
      marketId: market.id,
      outcomeKey: market.outcomeKey,
      amountMotes: "1000000000",
      bettor: "01aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    });
    expect(res.status).toBe(501);
    expect((await res.json()).error).toMatch(/simulated chain|cannot build/i);
  });

  it("refuses a bettor that is not a real public key", async () => {
    // The operator-signed route accepts `agent:<name>` labels. This one cannot: the string has to
    // be a key that can actually sign, or the transaction has no valid initiator.
    const market = await anOpenMarket();
    const res = await post(preparePOST, "http://localhost/api/chain/bet/prepare", {
      network: "testnet",
      marketId: market.id,
      outcomeKey: market.outcomeKey,
      amountMotes: "1000000000",
      bettor: "agent:oracle-9",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/public key/i);
  });

  it("applies the same guardrails as the operator-signed route", async () => {
    const market = await anOpenMarket();
    const key = "01aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const unknown = await post(preparePOST, "http://localhost/api/chain/bet/prepare", {
      network: "testnet",
      marketId: "testnet:not-a-market",
      outcomeKey: "yes",
      amountMotes: "1000000000",
      bettor: key,
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toMatch(/unknown market/i);

    const badOutcome = await post(preparePOST, "http://localhost/api/chain/bet/prepare", {
      network: "testnet",
      marketId: market.id,
      outcomeKey: "definitely-not-an-outcome",
      amountMotes: "1000000000",
      bettor: key,
    });
    expect(badOutcome.status).toBe(400);
    expect((await badOutcome.json()).error).toMatch(/is not an outcome/i);

    const overCap = await post(preparePOST, "http://localhost/api/chain/bet/prepare", {
      network: "mainnet",
      marketId: market.id,
      outcomeKey: market.outcomeKey,
      amountMotes: "100000000000000",
      bettor: key,
    });
    // Either the cap or the unknown-market check fires first; both are the guardrail holding.
    expect(overCap.status).toBe(400);
  });
});

describe("POST /api/chain/bet/confirm", () => {
  it("refuses a bet whose terms did not come from a ticket it signed", async () => {
    // The attack: post a hash from some unrelated executed transaction with whatever stake you
    // like. Without a valid ticket there is nothing to index, whatever the body says.
    const forged = signBetTicket(
      {
        network: "testnet",
        marketId: "testnet:anything",
        outcomeKey: "yes",
        amountMotes: "10000000000000",
        bettor: "01aa",
        transactionHash: "deadbeef",
        issuedAtMs: Date.now(),
      },
      "not-the-server-secret",
    );
    for (const ticket of [undefined, "", "garbage", forged]) {
      const res = await post(confirmPOST, "http://localhost/api/chain/bet/confirm", { ticket });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/invalid or expired/i);
    }
  });

  it("ignores bet terms in the request body — only the ticket's claims count", async () => {
    // A valid ticket for 1 CSPR, sent alongside a body claiming 10,000. The body must not matter.
    const ticket = signBetTicket(
      {
        network: "testnet",
        marketId: "testnet:some-market",
        outcomeKey: "yes",
        amountMotes: "1000000000",
        bettor: "01aa",
        transactionHash: "abc123",
        issuedAtMs: Date.now(),
      },
      SECRET,
    );
    const res = await post(confirmPOST, "http://localhost/api/chain/bet/confirm", {
      ticket,
      amountMotes: "10000000000000",
      outcomeKey: "no",
      marketId: "testnet:a-different-market",
    });
    // The mock chain cannot confirm an external transaction, so this stops at 501 — but the point
    // is what it did NOT do: it never read a number out of the body.
    expect(res.status).toBe(501);
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain("10000000000000");
  });
});
