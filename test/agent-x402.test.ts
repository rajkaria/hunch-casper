import { describe, it, expect, beforeEach } from "vitest";
import { POST as betPOST } from "@/app/api/agent/v1/bet/route";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";

beforeEach(__resetLedger);

const URL = "http://localhost/api/agent/v1/bet";
function post(body: unknown, paymentProof?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (paymentProof) headers["x-payment"] = Buffer.from(JSON.stringify(paymentProof)).toString("base64");
  return betPOST(new Request(URL, { method: "POST", headers, body: JSON.stringify(body) }));
}

const BET = {
  network: "testnet",
  marketId: "testnet:btc-150k-aug",
  outcomeKey: "yes",
  amountMotes: "1000000000",
  bettor: "agent:momentum",
};

describe("x402 REST bet (/api/agent/v1/bet)", () => {
  it("returns 402 with an x402 requirement when unpaid", async () => {
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
    const challenge = await (await post(BET)).json();
    const nonce = challenge.accepts[0].nonce;
    const proof = { scheme: "casper-x402", deployHash: "settlement-tx", nonce };

    const res = await post(BET, proof);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    const json = await res.json();
    expect(json.deployHash).toHaveLength(64);
    expect(json.poolByOutcomeMotes.yes).toBe("701000000000"); // seed 700 CSPR + 1 CSPR bet
  });

  it("rejects an invalid payment proof", async () => {
    const res = await post(BET, { scheme: "casper-x402", deployHash: "x", nonce: "wrong-nonce" });
    expect(res.status).toBe(402);
  });

  it("rejects a bet on an unknown market", async () => {
    const res = await post({ ...BET, marketId: "testnet:nope" });
    expect(res.status).toBe(400);
  });
});
