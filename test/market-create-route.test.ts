import { describe, it, expect, beforeEach } from "vitest";
import { POST as createPOST } from "@/app/api/markets/create/route";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { __resetConsumedBonds } from "@/lib/market-create";
import { __resetConsumedNonces } from "@/lib/agent-bet";

beforeEach(() => {
  __resetLedger();
  __resetCreatedMarkets();
  __resetActivity();
  __resetConsumedBonds();
  __resetConsumedNonces();
});

const BODY = {
  network: "testnet",
  claim: "Will CSPR cross $0.12 by year end",
  creator: "creator-1",
  oracle: "account-hash-arbiter",
  source: "coingecko",
  metric: "cspr_usd",
  method: "threshold",
  target: "0.12",
  comparator: "gte",
  deadlineIso: "2026-12-31T00:00:00.000Z",
  seedByFleet: false,
};

function post(body: unknown, proof?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (proof) headers["x-payment"] = Buffer.from(JSON.stringify(proof)).toString("base64");
  return createPOST(new Request("http://localhost/api/markets/create", { method: "POST", headers, body: JSON.stringify(body) }));
}

describe("POST /api/markets/create", () => {
  it("returns a 402 bond challenge with the recipe hash", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.x402Version).toBe(1);
    expect(json.recipeHash.startsWith("sha256:")).toBe(true);
    expect(json.accepts[0].scheme).toBe("casper-x402");
    expect(BigInt(json.accepts[0].maxAmountRequired) > 0n).toBe(true);
  });

  it("creates the market once the bond proof is presented (201)", async () => {
    const challenge = await (await post(BODY)).json();
    const nonce = challenge.accepts[0].nonce;
    const proof = { scheme: "casper-x402", deployHash: "bond-settlement-tx", nonce };
    const res = await post(BODY, proof);
    expect(res.status).toBe(201);
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
    const json = await res.json();
    expect(json.slug).toContain("user-");
    expect(json.recipeHash.startsWith("sha256:")).toBe(true);
  });

  it("422s a prohibited claim", async () => {
    const res = await post({ ...BODY, claim: "Will the governor be assassinated" });
    expect(res.status).toBe(422);
  });

  it("400s a bad network", async () => {
    const res = await post({ ...BODY, network: "devnet" });
    expect(res.status).toBe(400);
  });
});
