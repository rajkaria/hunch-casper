import { describe, it, expect, beforeEach } from "vitest";
import { POST as betPOST } from "@/app/api/agent/v1/bet/route";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";

beforeEach(() => {
  __resetLedger();
  __resetConsumedNonces();
});

const URL = "http://localhost/api/agent/v1/bet";
function post(body: unknown, paymentProof?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (paymentProof) headers["x-payment"] = Buffer.from(JSON.stringify(paymentProof)).toString("base64");
  return betPOST(new Request(URL, { method: "POST", headers, body: JSON.stringify(body) }));
}

/**
 * One full x402 exchange (challenge → pay → present proof). Unlike the retired Aug catalogue, the
 * Nov successors open with EMPTY pools, so a test that needs liquidity stakes it for real through
 * the same rail instead of inheriting a seed.
 */
async function placePaidBet(bet: Record<string, unknown>, deployHash: string): Promise<Response> {
  const nonce = (await (await post(bet)).json()).accepts[0].nonce;
  return post(bet, { scheme: "casper-x402", deployHash, nonce });
}

// btc-150k-aug matured and retired on 2026-08-01; btc-70k-nov is its live successor.
const BET = {
  network: "testnet",
  marketId: "testnet:btc-70k-nov",
  outcomeKey: "yes",
  amountMotes: "1000000000",
  bettor: "agent:momentum",
};

describe("x402 REST bet (/api/agent/v1/bet)", () => {
  it("returns 402 with an x402 requirement when unpaid", async () => {
    // Price the preview against a live counter-pool: the assertion below is about a payout quoted
    // from real opposing stake, which the unseeded successor only has once someone bets it.
    const counter = await placePaidBet(
      { ...BET, outcomeKey: "no", bettor: "agent:counterparty", amountMotes: "2300000000000" },
      "counter-stake-tx",
    );
    expect(counter.status).toBe(200);

    const res = await post(BET);
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.x402Version).toBe(1);
    expect(json.accepts[0].scheme).toBe("casper-x402");
    expect(json.accepts[0].payTo).toBeTruthy();
    expect(json.accepts[0].nonce).toBeTruthy();
    expect(BigInt(json.previewPayoutMotes) >= 1000000000n).toBe(true);
  });

  it("places the bet once a valid proof is presented, returning X-PAYMENT-RESPONSE", async () => {
    // The pool this bet lands on top of is staked here rather than inherited from a seed.
    const seed = await placePaidBet({ ...BET, bettor: "agent:liquidity", amountMotes: "700000000000" }, "seed-yes-tx");
    expect(seed.status).toBe(200);

    const challenge = await (await post(BET)).json();
    const nonce = challenge.accepts[0].nonce;
    const proof = { scheme: "casper-x402", deployHash: "settlement-tx", nonce };

    const res = await post(BET, proof);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    const json = await res.json();
    expect(json.deployHash).toHaveLength(64);
    expect(json.poolByOutcomeMotes.yes).toBe("701000000000"); // staked 700 CSPR + 1 CSPR bet
  });

  it("rejects an invalid payment proof", async () => {
    const res = await post(BET, { scheme: "casper-x402", deployHash: "x", nonce: "wrong-nonce" });
    expect(res.status).toBe(402);
  });

  it("rejects a bet on an unknown market", async () => {
    const res = await post({ ...BET, marketId: "testnet:nope" });
    expect(res.status).toBe(400);
  });

  it("rejects a replayed proof (one payment settles exactly one bet)", async () => {
    const nonce = (await (await post(BET)).json()).accepts[0].nonce;
    const proof = { scheme: "casper-x402", deployHash: "tx", nonce };
    expect((await post(BET, proof)).status).toBe(200); // first use
    expect((await post(BET, proof)).status).toBe(402); // replay rejected
  });

  it("rejects a replayed proof even on a fresh instance — the burn survives in the ledger's persisted dedupe set", async () => {
    const nonce = (await (await post(BET)).json()).accepts[0].nonce;
    const proof = { scheme: "casper-x402", deployHash: "tx-cold-start", nonce };
    expect((await post(BET, proof)).status).toBe(200);
    // A cold lambda has an empty in-process spent set; only the ledger dedupe key stands between
    // one paid transfer and N operator-funded escrows. Simulate it by clearing the process set.
    __resetConsumedNonces();
    expect((await post(BET, proof)).status).toBe(402);
  });

  it("rejects a proof minted for a different payer", async () => {
    const nonce = (await (await post({ ...BET, bettor: "agent:alice" })).json()).accepts[0].nonce;
    const proof = { scheme: "casper-x402", deployHash: "tx", nonce };
    // Bob presents Alice's proof for the same market/outcome/amount → nonce mismatch → 402.
    const res = await post({ ...BET, bettor: "agent:bob" }, proof);
    expect(res.status).toBe(402);
  });

  it("enforces the mainnet bet cap on the agent rail", async () => {
    const over = await post({
      network: "mainnet",
      marketId: "mainnet:btc-70k-nov",
      outcomeKey: "yes",
      amountMotes: "26000000000", // 26 CSPR > 25 cap
      bettor: "agent:whale",
    });
    expect(over.status).toBe(400);
  });
});
