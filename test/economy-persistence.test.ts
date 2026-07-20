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
import { appendAction, exportActivityState, listActions, __resetActivity } from "@/adapters/mock/activity-log";
import {
  ledgerGet,
  ledgerRecordBet,
  ledgerSettle,
  ledgerSettledEntries,
  ledgerSettlementFor,
  __resetLedger,
} from "@/adapters/mock/settlement-ledger";
import { bettingHalted, importBreakerState } from "@/agent/bet-breaker";
import {
  exportReleasedMarkets,
  importQuarantine,
  importReleasedMarkets,
  isQuarantined,
  quarantineMarket,
  releaseMarket,
  __resetQuarantine,
} from "@/agent/market-quarantine";
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

/** Base epoch for merge fixtures — far enough in the past that a live Date.now() always outranks it. */
const T0 = 1_753_000_000_000;

function resetAllState(): void {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetCreatedMarkets();
  __resetDemoSeed();
  __resetQuarantine();
  // Zero the breaker WITHOUT resetBreaker(): that would stamp clearedAt=now, which is exactly the
  // merge signal several tests below need to control precisely.
  importBreakerState({ consecutiveFailures: 0, lastFailure: null, trippedAt: null });
  __resetPersistenceForTests();
}

/** A minimal valid remote envelope, field-overridable per test. */
function remoteEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    savedAt: new Date(T0).toISOString(),
    settlement: { entries: [] },
    activity: { counter: 0, actions: [] },
    oracle: { reputations: [], recorded: [] },
    created: { created: [] },
    ...overrides,
  });
}

/**
 * Faithful in-memory Upstash-REST fake: `GET /get/<key>` serves the stored value, `POST` handles
 * both the plain `["SET", …]` command and the CAS `["EVAL", script, 1, key, expectedRev, payload]`
 * with real compare-and-set semantics — so the conflict/retry paths exercise the same state
 * machine production sees.
 */
function fakeKv(initial: string | null = null) {
  const kv = {
    value: initial,
    gets: 0,
    sets: [] as string[],
    evals: [] as { expected: string; payload: string }[],
    /** Test hook, runs after each GET has produced its response — mutate `value` here to
     * simulate a writer landing between this instance's GET and its SET. */
    afterGet: undefined as (() => void) | undefined,
  };
  const storedRev = (): number => {
    if (kv.value === null) return 0;
    try {
      const doc = JSON.parse(kv.value) as { rev?: unknown };
      return typeof doc.rev === "number" ? doc.rev : 0;
    } catch {
      return 0; // unparseable stored value → rev 0, same as the Lua script
    }
  };
  const ok = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("/get/")) {
      kv.gets += 1;
      const res = ok(kv.value);
      kv.afterGet?.();
      return res;
    }
    const cmd = JSON.parse(String(init?.body)) as unknown[];
    if (cmd[0] === "SET") {
      kv.sets.push(String(cmd[2]));
      kv.value = String(cmd[2]);
      return ok("OK");
    }
    if (cmd[0] === "EVAL") {
      const expected = String(cmd[4]);
      const payload = String(cmd[5]);
      kv.evals.push({ expected, payload });
      if (String(storedRev()) === expected) {
        kv.value = payload;
        return ok(1);
      }
      return ok(0);
    }
    throw new Error(`fakeKv: unexpected command ${String(init?.body)}`);
  }) as typeof fetch;
  return { kv, fetchImpl };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertion-side envelope poking; tests assert shapes field by field
function lastWrittenEnvelope(kv: ReturnType<typeof fakeKv>["kv"]): any {
  expect(kv.value).not.toBeNull();
  return JSON.parse(kv.value as string);
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

  it("round-trips quarantine release tombstones", () => {
    quarantineMarket({ slug: "coin-flip-5m", reason: "UnknownOutcome", deployHash: "ab".repeat(32), ts: T0 });
    releaseMarket("coin-flip-5m");
    const tombstones = exportReleasedMarkets();
    expect(tombstones).toHaveLength(1);

    const json = serializeEconomyState();
    resetAllState();
    expect(exportReleasedMarkets()).toEqual([]);

    expect(applyEconomyState(json)).toBe(true);
    expect(exportReleasedMarkets()).toEqual(tombstones);
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

  it("persist GETs the current envelope, then CAS-writes the snapshot (EVAL) with a bumped rev", async () => {
    seedEconomy(); // seed BEFORE stubbing env so mutation hooks stay no-ops
    stubKvEnv();
    expect(persistenceConfigured()).toBe(true);

    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("/get/")) return new Response(JSON.stringify({ result: null }), { status: 200 });
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    }) as typeof fetch;

    await persistEconomyState(fetchImpl);

    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe(`${URL_BASE}/get/${encodeURIComponent(ECONOMY_KV_KEY)}`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1].url).toBe(URL_BASE);
    expect(calls[1].init.method).toBe("POST");
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);

    const command = JSON.parse(String(calls[1].init.body)) as [string, string, number, string, string, string];
    expect(command[0]).toBe("EVAL");
    expect(command[3]).toBe(ECONOMY_KV_KEY);
    expect(command[4]).toBe("0"); // empty key → expected rev 0
    const envelope = JSON.parse(command[5]) as { v: number; rev: number; activity: { actions: { agent: string }[] } };
    expect(envelope.v).toBe(1);
    expect(envelope.rev).toBe(1);
    expect(envelope.activity.actions.some((a) => a.agent === "Momentum")).toBe(true);
  });

  it("coalesces same-tick persist calls into a single read-merge-write", async () => {
    seedEconomy();
    stubKvEnv();

    const { kv, fetchImpl } = fakeKv(null);
    const p1 = persistEconomyState(fetchImpl);
    const p2 = persistEconomyState(fetchImpl);
    const p3 = persistEconomyState(fetchImpl);
    await Promise.all([p1, p2, p3]);

    expect(kv.gets).toBe(1);
    expect(kv.evals.length + kv.sets.length).toBe(1);
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

describe("merge-on-persist — two writers must not clobber each other", () => {
  const URL_BASE = "https://kv.example";
  const TOKEN = "secret-token";
  function stubKvEnv(): void {
    vi.stubEnv("KV_REST_API_URL", URL_BASE);
    vi.stubEnv("KV_REST_API_TOKEN", TOKEN);
  }

  it("unions the activity feed and never regresses the round counter (the 42→5 incident)", async () => {
    appendAction({ agent: "Momentum", kind: "bet_placed", marketId: MARKET_ID, ts: T0 + 1_000 });
    stubKvEnv();
    const remote = remoteEnvelope({
      rev: 7,
      activity: {
        counter: 42,
        actions: [{ seq: 41, agent: "Arbiter", kind: "market_resolved", marketId: MARKET_ID, ts: T0 + 2_000 }],
      },
    });
    const { kv, fetchImpl } = fakeKv(remote);

    await persistEconomyState(fetchImpl);

    const written = lastWrittenEnvelope(kv);
    expect(written.rev).toBe(8);
    expect(written.activity.counter).toBe(42);
    const agents = written.activity.actions.map((a: { agent: string }) => a.agent);
    expect(agents).toContain("Momentum");
    expect(agents).toContain("Arbiter");

    // The merge landed in memory too: the feed shows both writers, and future seqs start above 42.
    expect(listActions().map((a) => a.agent)).toEqual(expect.arrayContaining(["Momentum", "Arbiter"]));
    expect(exportActivityState().counter).toBe(42);
  });

  it("unions created markets by slug — neither writer's launch is lost, and no duplicates", async () => {
    addCreatedMarket(CREATED);
    stubKvEnv();
    const other = { ...structuredClone(CREATED), slug: "merge-remote-market", title: "Created by the other writer" };
    const remote = remoteEnvelope({ created: { created: [structuredClone(CREATED), other] } });
    const { kv, fetchImpl } = fakeKv(remote);

    await persistEconomyState(fetchImpl);

    const written = lastWrittenEnvelope(kv);
    const writtenSlugs = written.created.created.map((d: { slug: string }) => d.slug).sort();
    expect(writtenSlugs).toEqual(["merge-remote-market", CREATED.slug].sort());
    expect([...listCreatedMarkets()].map((d) => d.slug).sort()).toEqual(["merge-remote-market", CREATED.slug].sort());
  });

  it("a settled market wins over the same market unsettled — a resolution is never un-resolved", async () => {
    // The remote writer settled the market...
    ledgerRecordBet({ marketId: MARKET_ID, bettor: "agent:momentum", outcomeKey: "no", amountMotes: csprToMotes(3) });
    ledgerSettle(MARKET_ID, "no");
    const remote = serializeEconomyState();
    resetAllState();
    // ...while this instance holds a stale, unsettled view of it.
    ledgerRecordBet({ marketId: MARKET_ID, bettor: "agent:contrarian", outcomeKey: "yes", amountMotes: csprToMotes(2) });
    stubKvEnv();
    const { kv, fetchImpl } = fakeKv(remote);

    await persistEconomyState(fetchImpl);

    const written = lastWrittenEnvelope(kv);
    const entry = written.settlement.entries.find((e: [string, { settlement: unknown }]) => e[0] === MARKET_ID);
    expect(entry?.[1].settlement).toBeTruthy();
    expect(ledgerSettlementFor(MARKET_ID)?.winningOutcomeKey).toBe("no");
  });

  it("between two unsettled views of one market, the one holding more escrowed stake wins", async () => {
    ledgerRecordBet({ marketId: MARKET_ID, bettor: "agent:remote", outcomeKey: "no", amountMotes: csprToMotes(3) });
    const remote = serializeEconomyState();
    resetAllState();
    ledgerRecordBet({ marketId: MARKET_ID, bettor: "agent:local-a", outcomeKey: "no", amountMotes: csprToMotes(3) });
    ledgerRecordBet({ marketId: MARKET_ID, bettor: "agent:local-b", outcomeKey: "yes", amountMotes: csprToMotes(2) });
    stubKvEnv();
    const { kv, fetchImpl } = fakeKv(remote);

    await persistEconomyState(fetchImpl);

    const written = lastWrittenEnvelope(kv);
    const entry = written.settlement.entries.find((e: [string, { stakes: Record<string, unknown> }]) => e[0] === MARKET_ID);
    expect(Object.keys(entry?.[1].stakes ?? {})).toEqual(expect.arrayContaining(["agent:local-a", "agent:local-b"]));
  });

  it("unions oracle resolutions by id and keeps the strongest reputation", async () => {
    const M2 = "testnet:cspr-price-05-aug";
    oracleRecordResolution("arbiter", MARKET_ID, false); // remote: 129 resolved / 123 accurate
    const remote = serializeEconomyState();
    resetAllState();
    oracleRecordResolution("arbiter", M2, true); // local: 129 resolved / 124 accurate
    stubKvEnv();
    const { kv, fetchImpl } = fakeKv(remote);

    await persistEconomyState(fetchImpl);

    const written = lastWrittenEnvelope(kv);
    expect([...written.oracle.recorded].sort()).toEqual([`arbiter:${MARKET_ID}`, `arbiter:${M2}`].sort());
    const arbiter = written.oracle.reputations.find((r: [string, unknown]) => r[0] === "arbiter");
    expect(arbiter?.[1]).toMatchObject({ resolved: 129, accurate: 124 });

    // In memory the union guards idempotence: the remote's resolution cannot be double-counted.
    vi.unstubAllEnvs();
    const after = oracleRecordResolution("arbiter", MARKET_ID, true);
    expect(after.resolved).toBe(129);
  });

  it("a placement/reset newer than a stale trip clears the merged breaker", async () => {
    importBreakerState({ consecutiveFailures: 0, lastFailure: null, trippedAt: null, clearedAt: T0 + 2_000 });
    stubKvEnv();
    const failure = { agentId: "agent:value", deployHash: "cd".repeat(32), reason: "chain submission failed", ts: T0 + 1_000 };
    const remote = remoteEnvelope({ breaker: { consecutiveFailures: 3, lastFailure: failure, trippedAt: T0 + 1_000 } });
    const { kv, fetchImpl } = fakeKv(remote);

    await persistEconomyState(fetchImpl);

    expect(lastWrittenEnvelope(kv).breaker.trippedAt).toBeNull();
    expect(bettingHalted()).toBe(false);
  });

  it("a trip newer than the last placement survives the merge — money-loss evidence is kept", async () => {
    importBreakerState({ consecutiveFailures: 0, lastFailure: null, trippedAt: null, clearedAt: T0 + 2_000 });
    stubKvEnv();
    const failure = { agentId: "agent:value", deployHash: "cd".repeat(32), reason: "chain submission failed", ts: T0 + 3_000 };
    const remote = remoteEnvelope({ breaker: { consecutiveFailures: 3, lastFailure: failure, trippedAt: T0 + 3_000 } });
    const { kv, fetchImpl } = fakeKv(remote);

    await persistEconomyState(fetchImpl);

    expect(lastWrittenEnvelope(kv).breaker.trippedAt).toBe(T0 + 3_000);
    expect(bettingHalted()).toBe(true);
  });

  it("an operator release is not resurrected by a writer still holding the quarantine", async () => {
    const entry = { slug: "coin-flip-5m", reason: "UnknownOutcome: User error: 3", deployHash: "ab".repeat(32), ts: T0 + 1_000 };
    importQuarantine([entry]);
    releaseMarket("coin-flip-5m"); // stamps a release tombstone at Date.now(), long after the quarantine ts
    stubKvEnv();
    const remote = remoteEnvelope({ quarantine: [entry] });
    const { kv, fetchImpl } = fakeKv(remote);

    await persistEconomyState(fetchImpl);

    const written = lastWrittenEnvelope(kv);
    expect(written.quarantine).toEqual([]);
    expect(written.quarantineReleased.map((r: [string, number]) => r[0])).toContain("coin-flip-5m");
    expect(isQuarantined("coin-flip-5m")).toBe(false);
  });

  it("a re-quarantine newer than the release sticks — the fault came back", async () => {
    importReleasedMarkets([["coin-flip-5m", T0 + 2_000]]);
    stubKvEnv();
    const entry = { slug: "coin-flip-5m", reason: "UnknownOutcome: User error: 3", deployHash: "ab".repeat(32), ts: T0 + 3_000 };
    const remote = remoteEnvelope({ quarantine: [entry] });
    const { kv, fetchImpl } = fakeKv(remote);

    await persistEconomyState(fetchImpl);

    const written = lastWrittenEnvelope(kv);
    expect(written.quarantine.map((q: { slug: string }) => q.slug)).toContain("coin-flip-5m");
    expect(isQuarantined("coin-flip-5m")).toBe(true);
  });

  it("KV GET failure fails open to a plain last-writer-wins SET — downtime never blocks the flush", async () => {
    appendAction({ agent: "Momentum", kind: "bet_placed", marketId: MARKET_ID });
    stubKvEnv();
    const writes: string[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/get/")) throw new Error("KV read path is down");
      const cmd = JSON.parse(String(init?.body)) as [string, string, string];
      writes.push(cmd[0]);
      expect(cmd[0]).toBe("SET");
      const envelope = JSON.parse(cmd[2]) as { activity: { actions: { agent: string }[] } };
      expect(envelope.activity.actions.some((a) => a.agent === "Momentum")).toBe(true);
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    }) as typeof fetch;

    await expect(persistEconomyState(fetchImpl)).resolves.toBeUndefined();
    expect(writes).toEqual(["SET"]);
  });

  it("compare-and-retry: a writer landing between GET and SET is re-read and re-merged, not clobbered", async () => {
    appendAction({ agent: "Momentum", kind: "bet_placed", marketId: MARKET_ID, ts: T0 + 500 });
    stubKvEnv();
    const actA = { seq: 4, agent: "Arbiter", kind: "market_resolved", marketId: MARKET_ID, ts: T0 + 1_000 };
    const actB = { seq: 5, agent: "Genesis", kind: "market_created", marketId: MARKET_ID, ts: T0 + 2_000 };
    const { kv, fetchImpl } = fakeKv(remoteEnvelope({ rev: 1, activity: { counter: 5, actions: [actA] } }));
    kv.afterGet = () => {
      // A concurrent writer lands AFTER our GET and BEFORE our SET.
      kv.value = remoteEnvelope({ rev: 2, activity: { counter: 6, actions: [actB, actA] } });
      kv.afterGet = undefined;
    };

    await persistEconomyState(fetchImpl);

    expect(kv.gets).toBe(2);
    expect(kv.evals.length).toBe(2);
    const written = lastWrittenEnvelope(kv);
    expect(written.rev).toBe(3);
    const agents = written.activity.actions.map((a: { agent: string }) => a.agent);
    expect(agents).toEqual(expect.arrayContaining(["Momentum", "Arbiter", "Genesis"]));
    expect(written.activity.counter).toBe(6);
  });

  it("a KV without EVAL falls back to plain SET and stops attempting CAS on this instance", async () => {
    appendAction({ agent: "Momentum", kind: "bet_placed", marketId: MARKET_ID });
    stubKvEnv();
    let gets = 0;
    let evals = 0;
    const sets: string[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/get/")) {
        gets += 1;
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }
      const cmd = JSON.parse(String(init?.body)) as unknown[];
      if (cmd[0] === "EVAL") {
        evals += 1;
        return new Response(JSON.stringify({ error: "ERR unknown command 'EVAL'" }), { status: 400 });
      }
      sets.push(String(cmd[2]));
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    }) as typeof fetch;

    await persistEconomyState(fetchImpl);
    expect(evals).toBe(1);
    expect(sets.length).toBe(1);

    await persistEconomyState(fetchImpl); // second flush: CAS is known-unsupported, straight to SET
    expect(evals).toBe(1);
    expect(sets.length).toBe(2);
    expect(gets).toBe(2); // still read-merge each time — CAS is only the retry layer; the merge is the fix
  });
});
