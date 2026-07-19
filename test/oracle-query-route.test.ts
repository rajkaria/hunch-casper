import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST as queryPOST, __resetQueryMeter } from "@/app/api/oracle/query/route";
import { resolveMarket } from "@/agent/arbiter";
import { createContainer } from "@/lib/container";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { __resetEvidenceStore } from "@/adapters/mock/mock-evidence-store";
import { __resetResolutionEvidence } from "@/adapters/mock/resolution-evidence-ledger";

const savedEnv = { ...process.env };
beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetCreatedMarkets();
  __resetEvidenceStore();
  __resetResolutionEvidence();
  __resetQueryMeter();
});
afterEach(() => {
  process.env = { ...savedEnv };
});

const SLUG = "cspr-price-05-aug";

function query(body: unknown, proof?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (proof) headers["x-payment"] = Buffer.from(JSON.stringify(proof)).toString("base64");
  return queryPOST(new Request("http://localhost/api/oracle/query", { method: "POST", headers, body: JSON.stringify(body) }));
}

describe("POST /api/oracle/query", () => {
  it("answers a resolved market for free (within the tier), carrying evidence + reputation", async () => {
    const container = createContainer("testnet");
    await resolveMarket(container, SLUG);

    const res = await query({ network: "testnet", slug: SLUG, caller: "consumer-1" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.answer.resolved).toBe(true);
    expect(typeof json.answer.claimResolvedTrue).toBe("boolean");
    expect(json.evidence.bundleHash.startsWith("sha256:")).toBe(true);
    expect(json.oracle.id).toBe("arbiter");
    expect(json.meter.tier).toBe("free");
  });

  it("reports an unresolved market as not-yet-decided", async () => {
    const res = await query({ network: "testnet", slug: SLUG, caller: "consumer-x" });
    const json = await res.json();
    expect(json.answer.resolved).toBe(false);
    expect(json.answer.winningOutcomeKey).toBeNull();
  });

  it("meters: past the free tier it 402s, a valid proof unlocks, and a replay is rejected", async () => {
    process.env.ORACLE_FREE_QUERIES_PER_HOUR = "0"; // every query paid
    const container = createContainer("testnet");
    await resolveMarket(container, SLUG);

    const challenge = await query({ network: "testnet", slug: SLUG, caller: "payer-1" });
    expect(challenge.status).toBe(402);
    const cj = await challenge.json();
    const nonce = cj.accepts[0].nonce;
    const proof = { scheme: "casper-x402", deployHash: "query-settlement", nonce };

    const paid = await query({ network: "testnet", slug: SLUG, caller: "payer-1" }, proof);
    expect(paid.status).toBe(200);
    expect((await paid.json()).meter.tier).toBe("paid");

    // Same proof again → replay rejected.
    const replay = await query({ network: "testnet", slug: SLUG, caller: "payer-1" }, proof);
    expect(replay.status).toBe(402);
    expect((await replay.json()).error).toMatch(/already spent/);
  });

  it("400s a missing slug or bad network", async () => {
    expect((await query({ network: "testnet", caller: "c" })).status).toBe(400);
    expect((await query({ network: "devnet", slug: SLUG })).status).toBe(400);
  });
});
