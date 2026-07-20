/**
 * Every route that MUTATES the in-process economy (created markets, activity log, settlements)
 * must hydrate the persisted envelope before acting and AWAIT the KV flush before returning —
 * the discipline the tick route already follows. A serverless instance can freeze the moment the
 * response is sent, so a fire-and-forget persist is a persist that never happened.
 *
 * Found in production 2026-07-20: POST /api/markets/create returned 201 for a REAL on-chain
 * market (vault entry + bond paid), then the instance froze before the hook's async flush — the
 * app's mirror lost the market entirely. On an un-hydrated instance the same route also composes
 * against an EMPTY created-markets list, so its slug seq and duplicate check are wrong.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/adapters/persist/economy-state", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/adapters/persist/economy-state")>();
  return {
    ...original,
    hydrateEconomyState: vi.fn(async () => {}),
    persistEconomyState: vi.fn(async () => {}),
  };
});

import { hydrateEconomyState, persistEconomyState } from "@/adapters/persist/economy-state";
import { POST as createPOST } from "@/app/api/markets/create/route";
import { POST as betPOST } from "@/app/api/agent/v1/bet/route";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { __resetConsumedBonds } from "@/lib/market-create";
import { __resetConsumedNonces } from "@/lib/agent-bet";

const hydrate = vi.mocked(hydrateEconomyState);
const persist = vi.mocked(persistEconomyState);

beforeEach(() => {
  __resetLedger();
  __resetCreatedMarkets();
  __resetActivity();
  __resetConsumedBonds();
  __resetConsumedNonces();
  hydrate.mockClear();
  persist.mockClear();
});

function req(url: string, body: unknown, proof?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (proof) headers["x-payment"] = Buffer.from(JSON.stringify(proof)).toString("base64");
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

const CREATE_BODY = {
  network: "testnet",
  claim: "Will CSPR cross $0.25 by mid-2027",
  creator: "creator-flush",
  oracle: "account-hash-arbiter",
  source: "coingecko",
  metric: "cspr_usd",
  method: "threshold",
  target: "0.25",
  comparator: "gte",
  deadlineIso: "2027-06-30T00:00:00.000Z",
  seedByFleet: false,
};

const BET_BODY = {
  network: "testnet",
  marketId: "testnet:coin-flip-5m",
  outcomeKey: "heads",
  amountMotes: "1000000000",
  bettor: "agent:flush-test",
};

describe("economy flush discipline on mutating routes", () => {
  it("create route hydrates before composing and awaits the flush after creating", async () => {
    const challenge = await (
      await createPOST(req("http://localhost/api/markets/create", CREATE_BODY))
    ).json();
    const nonce = challenge.accepts[0].nonce;
    hydrate.mockClear();
    persist.mockClear();

    const res = await createPOST(
      req("http://localhost/api/markets/create", CREATE_BODY, {
        scheme: "casper-x402",
        deployHash: "bond-settlement-tx",
        nonce,
      }),
    );
    expect(res.status).toBe(201);
    expect(hydrate).toHaveBeenCalled();
    expect(persist).toHaveBeenCalled();
    // Hydrate must come first: composing against a cold instance's empty created-markets list
    // corrupts the slug seq and defeats the duplicate check.
    expect(hydrate.mock.invocationCallOrder[0]).toBeLessThan(persist.mock.invocationCallOrder[0]);
  });

  it("create route awaits no flush when it only hands back the 402 challenge", async () => {
    const res = await createPOST(req("http://localhost/api/markets/create", CREATE_BODY));
    expect(res.status).toBe(402);
    expect(persist).not.toHaveBeenCalled();
  });

  it("agent bet route hydrates before betting and awaits the flush after placing", async () => {
    const challenge = await (await betPOST(req("http://localhost/api/agent/v1/bet", BET_BODY))).json();
    const nonce = challenge.accepts[0].nonce;
    hydrate.mockClear();
    persist.mockClear();

    const res = await betPOST(
      req("http://localhost/api/agent/v1/bet", BET_BODY, {
        scheme: "casper-x402",
        deployHash: "settlement-tx",
        nonce,
      }),
    );
    expect(res.status).toBe(200);
    expect(hydrate).toHaveBeenCalled();
    expect(persist).toHaveBeenCalled();
    expect(hydrate.mock.invocationCallOrder[0]).toBeLessThan(persist.mock.invocationCallOrder[0]);
  });
});

describe("tick resilience around explicit resolves", () => {
  it("an explicit resolve that reverts is logged and skipped, not fatal to the tick", async () => {
    const { runEconomyTick } = await import("@/agent/economy");
    const { createContainer } = await import("@/lib/container");
    const base = createContainer("testnet");
    const container = {
      ...base,
      chain: {
        ...base.chain,
        resolveMarket: vi.fn().mockRejectedValue(new Error("transaction reverted: User error: 1")),
      },
    };
    const report = await runEconomyTick(container, {
      seq: 0,
      resolveSlugs: ["cspr-price-05-aug"],
    });
    // The tick completed: bets and the leaderboard snapshot survived the failed close.
    expect(report.seq).toBe(0);
    expect(report.arbiterActions.every((a) => a.marketId !== "testnet:cspr-price-05-aug")).toBe(true);
  });
});
