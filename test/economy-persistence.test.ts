/**
 * Env-gated KV persistence for the in-process economy state. The four mock ledgers (settlement,
 * activity, oracle reputation, Genesis-created markets) are module singletons that reset on every
 * serverless cold start and diverge across instances — a judge's bet could vanish when the next
 * request lands on a different lambda. `economy-state` folds all four into one versioned envelope,
 * snapshots it to Upstash-Redis-REST-compatible KV after each mutation, and hydrates it once per
 * instance before the first read. Unconfigured (CI, local, tests) it is a strict no-op.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ECONOMY_KV_KEY,
  applyEconomyState,
  hydrateEconomyState,
  persistEconomyState,
  persistenceConfigured,
  rehydrateEconomyState,
  serializeEconomyState,
  __resetPersistenceForTests,
} from "@/adapters/persist/economy-state";
import { appendAction, listActions, __resetActivity } from "@/adapters/mock/activity-log";
import {
  ledgerGet,
  ledgerRecordBet,
  ledgerSettle,
  ledgerSettledEntries,
  __resetLedger,
} from "@/adapters/mock/settlement-ledger";
import {
  oracleRecordResolution,
  oracleReputationOf,
  __resetOracleLedger,
} from "@/adapters/mock/oracle-ledger";
import {
  addCreatedMarket,
  listCreatedMarkets,
  __resetCreatedMarkets,
} from "@/adapters/mock/market-source";
import { ensureDemoSeed, __resetDemoSeed } from "@/adapters/mock/demo-seed";
import { csprToMotes } from "@/core/types";
import type { MarketDefinition } from "@/core/catalogue";

/** A valid Genesis-style created market (shape mirrors src/core/catalogue.ts definitions). */
const CREATED: MarketDefinition = {
  slug: "persistence-roundtrip-market",
  title: "Will the persisted economy survive a cold start?",
  subtitle: "Meta · created by a test, not Genesis",
  category: "casper-native",
  outcomes: [
    { key: "yes", label: "Yes" },
    { key: "no", label: "No" },
  ],
  feeBps: 200,
  cadence: "one-shot",
  resolver: {
    kind: "threshold",
    source: "coingecko",
    metric: "cspr_usd",
    target: "0.05",
    comparator: "gte",
    description: "Round-trip fixture — never resolved.",
  },
  deadlineIso: "2026-08-01T00:00:00.000Z",
  seedPoolMotes: { yes: "1000000000", no: "1000000000" },
};

const MARKET_ID = "testnet:cspr-staking-apy-11";

function resetAllState(): void {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetCreatedMarkets();
  __resetDemoSeed();
  __resetPersistenceForTests();
}

/** Seed a small but complete economy across all four state modules. */
function seedEconomy(): void {
  ledgerRecordBet({ marketId: MARKET_ID, bettor: "agent:momentum", outcomeKey: "no", amountMotes: csprToMotes(3) });
  ledgerRecordBet({ marketId: MARKET_ID, bettor: "agent:contrarian", outcomeKey: "yes", amountMotes: csprToMotes(2) });
  ledgerSettle(MARKET_ID, "no");
  oracleRecordResolution("arbiter", MARKET_ID, true);
  addCreatedMarket(CREATED);
  appendAction({
    agent: "Momentum",
    kind: "bet_placed",
    marketId: MARKET_ID,
    outcomeKey: "no",
    amountMotes: csprToMotes(3),
    narration: "Momentum stakes 3 CSPR on No via x402.",
  });
}

beforeEach(() => {
  resetAllState();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetAllState();
});

describe("serializeEconomyState / applyEconomyState round-trip", () => {
  it("restores all four modules exactly, and the activity counter keeps issuing fresh seqs", () => {
    seedEconomy();

    const actionsBefore = listActions();
    const settledBefore = ledgerSettledEntries("testnet");
    const marketBefore = ledgerGet(MARKET_ID);
    const createdBefore = [...listCreatedMarkets()];
    const arbiterBefore = oracleReputationOf("arbiter");
    const maxSeqBefore = Math.max(...actionsBefore.map((a) => a.seq));

    const json = serializeEconomyState();
    resetAllState();

    // Sanity: the reset really emptied everything (so equality below proves restoration).
    expect(ledgerSettledEntries("testnet")).toEqual([]);
    expect(listCreatedMarkets()).toEqual([]);

    expect(applyEconomyState(json)).toBe(true);

    expect(listActions()).toEqual(actionsBefore);
    expect(ledgerSettledEntries("testnet")).toEqual(settledBefore);
    expect(ledgerGet(MARKET_ID)).toEqual(marketBefore);
    expect([...listCreatedMarkets()]).toEqual(createdBefore);
    expect(oracleReputationOf("arbiter")).toEqual(arbiterBefore);

    // The counter round-trips too: new actions never collide with restored seqs.
    const next = appendAction({ agent: "Genesis", kind: "market_created", marketId: "testnet:the-flip" });
    expect(next.seq).toBeGreaterThan(maxSeqBefore);

    // The oracle's per-(oracle, market) idempotence set round-trips: re-recording is a no-op.
    const again = oracleRecordResolution("arbiter", MARKET_ID, false);
    expect(again.resolved).toBe(arbiterBefore.resolved);
    expect(again.accurate).toBe(arbiterBefore.accurate);
  });

  it("marks the demo seed as done, so a hydrated instance never double-seeds", () => {
    seedEconomy();
    const json = serializeEconomyState();
    resetAllState();

    expect(applyEconomyState(json)).toBe(true);
    const actionCount = listActions().length;
    const settledCount = ledgerSettledEntries("testnet").length;

    // Lift the NODE_ENV=test guard so ensureDemoSeed WOULD seed if not marked done.
    vi.stubEnv("NODE_ENV", "development");
    ensureDemoSeed("testnet");

    expect(listActions().length).toBe(actionCount);
    expect(ledgerSettledEntries("testnet").length).toBe(settledCount);
  });

  it("rejects garbage payloads and leaves current state untouched", () => {
    seedEconomy();
    const actionsBefore = listActions();
    const settledBefore = ledgerSettledEntries("testnet");

    expect(applyEconomyState("{definitely not json")).toBe(false);
    expect(applyEconomyState(JSON.stringify(null))).toBe(false);
    expect(applyEconomyState(JSON.stringify({ v: 2 }))).toBe(false); // future version → refuse
    expect(
      applyEconomyState(
        JSON.stringify({
          v: 1,
          savedAt: "2026-07-05T00:00:00.000Z",
          settlement: { entries: "not-an-array" },
          activity: { counter: 0, actions: [] },
          oracle: { reputations: [], recorded: [] },
          created: { created: [] },
        }),
      ),
    ).toBe(false);

    expect(listActions()).toEqual(actionsBefore);
    expect(ledgerSettledEntries("testnet")).toEqual(settledBefore);
  });
});

describe("unconfigured KV (default: CI, local, tests)", () => {
  it("hydrate + persist are no-ops that never touch fetch", async () => {
    const fetchSpy = vi.fn();
    expect(persistenceConfigured()).toBe(false);

    await hydrateEconomyState(fetchSpy as unknown as typeof fetch);
    seedEconomy();
    await persistEconomyState(fetchSpy as unknown as typeof fetch);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("configured KV (injected fetch)", () => {
  const URL_BASE = "https://kv.example";
  const TOKEN = "secret-token";

  function stubKvEnv(): void {
    vi.stubEnv("KV_REST_API_URL", URL_BASE);
    vi.stubEnv("KV_REST_API_TOKEN", TOKEN);
  }

  it("persistEconomyState POSTs the serialized envelope as an Upstash SET command", async () => {
    seedEconomy(); // seed BEFORE stubbing env so mutation hooks stay no-ops
    stubKvEnv();
    expect(persistenceConfigured()).toBe(true);

    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    }) as typeof fetch;

    await persistEconomyState(fetchImpl);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(URL_BASE);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);

    const command = JSON.parse(String(calls[0].init.body)) as [string, string, string];
    expect(command[0]).toBe("SET");
    expect(command[1]).toBe(ECONOMY_KV_KEY);
    const envelope = JSON.parse(command[2]) as { v: number; activity: { actions: { agent: string }[] } };
    expect(envelope.v).toBe(1);
    expect(envelope.activity.actions.some((a) => a.agent === "Momentum")).toBe(true);
  });

  it("coalesces same-tick persist calls into a single write", async () => {
    seedEconomy();
    stubKvEnv();

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: "OK" }), { status: 200 }));
    const p1 = persistEconomyState(fetchImpl as unknown as typeof fetch);
    const p2 = persistEconomyState(fetchImpl as unknown as typeof fetch);
    const p3 = persistEconomyState(fetchImpl as unknown as typeof fetch);
    await Promise.all([p1, p2, p3]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("hydrateEconomyState GETs the key once per instance and applies the stored envelope", async () => {
    seedEconomy();
    const json = serializeEconomyState();
    const actionsBefore = listActions();
    const settledBefore = ledgerSettledEntries("testnet");
    resetAllState();
    stubKvEnv();

    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ result: json }), { status: 200 });
    }) as typeof fetch;

    await hydrateEconomyState(fetchImpl);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${URL_BASE}/get/${encodeURIComponent(ECONOMY_KV_KEY)}`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(listActions()).toEqual(actionsBefore);
    expect(ledgerSettledEntries("testnet")).toEqual(settledBefore);

    // Once per instance: a second hydrate is a guarded no-op.
    await hydrateEconomyState(fetchImpl);
    expect(calls.length).toBe(1);
  });

  it("hydrate on an empty key ({result: null}) leaves state empty and resolves", async () => {
    stubKvEnv();
    const fetchImpl = (async () => new Response(JSON.stringify({ result: null }), { status: 200 })) as typeof fetch;
    await hydrateEconomyState(fetchImpl);
    expect(ledgerSettledEntries("testnet")).toEqual([]);
  });

  it("hydrate survives KV downtime: fetch failure resolves without throwing and marks hydrated", async () => {
    stubKvEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error("KV is down");
    });

    await expect(hydrateEconomyState(fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    // Marked hydrated: no retry storm on subsequent reads.
    await hydrateEconomyState(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("persist survives KV downtime: fetch failure resolves without throwing", async () => {
    seedEconomy();
    stubKvEnv();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error("KV is down");
    });

    await expect(persistEconomyState(fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("rehydrateEconomyState — the tick's fresh-view guard", () => {
  it("re-reads KV even after a prior hydrate marked the instance done", async () => {
    seedEconomy();
    const full = serializeEconomyState();
    const actionsBefore = listActions();
    resetAllState();
    vi.stubEnv("KV_REST_API_URL", "https://kv.example.test");
    vi.stubEnv("KV_REST_API_TOKEN", "kv-token");

    // First hydrate sees an EMPTY key and marks the instance hydrated.
    const empty = vi.fn(async () => new Response(JSON.stringify({ result: null }), { status: 200 }));
    await hydrateEconomyState(empty as unknown as typeof fetch);
    expect(listActions()).toEqual([]);

    // Another instance persisted the real history since; the once-per-instance hydrate would
    // never see it — the tick's forced re-hydrate must.
    const fresh = vi.fn(async () => new Response(JSON.stringify({ result: full }), { status: 200 }));
    await rehydrateEconomyState(fresh as unknown as typeof fetch);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(listActions()).toEqual(actionsBefore);
  });
});
