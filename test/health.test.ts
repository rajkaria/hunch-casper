/**
 * The operator health surface. The point of these tests is the *judgement*: a deployment can be
 * fully configured and still be dead (real mode with no cron secret 401s every scheduled tick),
 * or look broken and be perfectly fine (mock mode has no signing key by design). Each degraded
 * combination is asserted as a table over the pure evaluator, then the route is checked for the
 * two things a monitor depends on — the status code and no-store caching.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildHealthReport, TICK_STALE_MS, type HealthInputs } from "@/core/health";
import { gatherHealth } from "@/lib/health";
import { GET as healthGET } from "@/app/api/health/route";
import { probePersistence, __resetPersistenceForTests } from "@/adapters/persist/economy-state";
import { appendAction, __resetActivity } from "@/adapters/mock/activity-log";
import { __resetDemoSeed } from "@/adapters/mock/demo-seed";
import { fleetTurnFloorMotes } from "@/lib/health";
import {
  prophetTurnCostMotes,
  PROPHET_GAS_FLOOR_MOTES,
  PROPHET_ESCROW_GAS_FLOOR_MOTES,
} from "@/agent/prophet";
import { PROPHETS, MAX_CONVICTION_MULTIPLIER } from "@/core/prophet-strategies";
import { csprToMotes } from "@/core/types";
import { NATIVE_TRANSFER_MINIMUM_MOTES } from "@/config/network";

const NOW = 1_780_000_000_000;

/** A fully-wired real-mode deployment: every check should be `ok`. */
function healthyReal(): HealthInputs {
  return {
    network: "testnet",
    chainMode: "real",
    contracts: {
      marketFactory: "hash-" + "7f".repeat(32),
      oracleRegistry: "hash-" + "26".repeat(32),
      vault: "hash-" + "c6".repeat(32),
      vaultV2: "hash-" + "ce".repeat(32),
      fieldMarket: "hash-" + "dd".repeat(32),
      agentRegistry: "hash-" + "a9".repeat(32),
    },
    marketAddressCount: 6,
    fieldMarketCount: 1,
    persistence: { configured: true, reachable: true, status: 200, latencyMs: 12 },
    x402: { payToConfigured: true, legacyOptIn: false },
    signer: { bettorKeyConfigured: true, oracleKeyConfigured: true },
    creation: { bondBlocker: null, oracleAccountConfigured: true },
    cronSecretConfigured: true,
    csprCloudKeyConfigured: true,
    economy: { actionCount: 12, newestActionTs: NOW - 60_000 },
    fleet: [
      { agentId: "Momentum", account: "01aa", accountHash: "account-hash-aa", balanceMotes: "40000000000" },
      { agentId: "Contrarian", account: "01bb", accountHash: "account-hash-bb", balanceMotes: "40000000000" },
    ],
    breaker: { consecutiveFailures: 0, trippedAt: null },
    quarantinedMarkets: [],
    fleetMinBalanceMotes: "3200000000",
    treasury: {
      account: "01cc",
      accountHash: "account-hash-cc",
      // 200 rounds of runway at 5 CSPR/round — comfortably above every cadence floor.
      balanceMotes: "1000000000000",
      perRoundCostMotes: "5000000000",
    },
    now: NOW,
  };
}

function statusOf(report: ReturnType<typeof buildHealthReport>, name: string): string {
  const c = report.checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check named ${name}; got ${report.checks.map((x) => x.name).join(", ")}`);
  return c.status;
}

describe("buildHealthReport — a fully wired real-mode deployment", () => {
  it("reports ok with no problems and never claims to be simulated", () => {
    const r = buildHealthReport(healthyReal());
    expect(r.status).toBe("ok");
    expect(r.problems).toEqual([]);
    expect(r.simulated).toBe(false);
    expect(r.checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("stamps a real ISO timestamp from the injected clock, not the wall clock", () => {
    expect(buildHealthReport(healthyReal()).generatedAt).toBe(new Date(NOW).toISOString());
  });
});

describe("buildHealthReport — mock mode skips what does not apply", () => {
  const mock: HealthInputs = {
    ...healthyReal(),
    chainMode: "mock",
    contracts: {},
    marketAddressCount: 0,
    persistence: { configured: false, reachable: false },
    x402: { payToConfigured: false, legacyOptIn: false },
    signer: { bettorKeyConfigured: false, oracleKeyConfigured: false },
    cronSecretConfigured: false,
  };

  it("is ok — an unconfigured local/CI run is not a broken deployment", () => {
    const r = buildHealthReport(mock);
    expect(r.status).toBe("ok");
    expect(r.simulated).toBe(true);
    expect(statusOf(r, "contracts")).toBe("skip");
    expect(statusOf(r, "persistence")).toBe("skip");
    expect(statusOf(r, "x402")).toBe("skip");
    expect(statusOf(r, "signer")).toBe("skip");
    expect(statusOf(r, "cron")).toBe("skip");
  });
});

describe("buildHealthReport — the failures that actually stop the economy", () => {
  it("fails when real mode has no cron secret: every scheduled tick 401s", () => {
    const r = buildHealthReport({ ...healthyReal(), cronSecretConfigured: false });
    expect(statusOf(r, "cron")).toBe("fail");
    expect(r.status).toBe("degraded");
  });

  it("fails when real mode has no bettor key: nothing can be signed", () => {
    const r = buildHealthReport({
      ...healthyReal(),
      signer: { bettorKeyConfigured: false, oracleKeyConfigured: false },
    });
    expect(statusOf(r, "signer.bettor")).toBe("fail");
    expect(r.status).toBe("degraded");
  });

  it("fails when real mode has no routing target at all", () => {
    const r = buildHealthReport({ ...healthyReal(), contracts: {}, marketAddressCount: 0 });
    expect(statusOf(r, "contracts.routing")).toBe("fail");
    expect(r.status).toBe("degraded");
  });

  /**
   * The silent one: the vault caps a market at 8 outcomes, so a 177-candidate market that loses
   * its own package has no bet path at all — while routing, vault, and factory all stay green.
   */
  it("fails when a wide field is on the board with no FieldMarket package", () => {
    const base = healthyReal();
    const r = buildHealthReport({
      ...base,
      contracts: { ...base.contracts, fieldMarket: undefined },
    });
    expect(statusOf(r, "contracts.fieldMarket")).toBe("fail");
    expect(statusOf(r, "contracts.routing")).toBe("ok");
    expect(r.status).toBe("degraded");
  });

  it("says nothing about FieldMarket on a board with no wide field", () => {
    const base = healthyReal();
    const r = buildHealthReport({
      ...base,
      fieldMarketCount: 0,
      contracts: { ...base.contracts, fieldMarket: undefined },
    });
    expect(r.checks.some((c) => c.name === "contracts.fieldMarket")).toBe(false);
    expect(r.status).toBe("ok");
  });

  it("fails when KV is configured but unreachable — the rotated-token trap", () => {
    const r = buildHealthReport({
      ...healthyReal(),
      persistence: { configured: true, reachable: false, status: 401 },
    });
    expect(statusOf(r, "persistence")).toBe("fail");
    expect(r.checks.find((c) => c.name === "persistence")?.detail).toContain("401");
    expect(r.status).toBe("degraded");
  });
});

describe("buildHealthReport — persistence revision is observable", () => {
  // The envelope's `rev` is the only outside proof that compare-and-set is live: it must climb on
  // every flush. Without it in health, a silent fall-open to last-writer-wins looks identical to a
  // healthy KV — which is exactly how the 42 → 5 truncation went unnoticed.
  it("reports the stored envelope revision when KV returns one", () => {
    const r = buildHealthReport({
      ...healthyReal(),
      persistence: { configured: true, reachable: true, status: 200, latencyMs: 12, rev: 43 },
    });
    expect(statusOf(r, "persistence")).toBe("ok");
    expect(r.checks.find((c) => c.name === "persistence")?.detail).toContain("rev 43");
  });

  it("stays ok and says so when the envelope predates rev (or the key is empty)", () => {
    const r = buildHealthReport({
      ...healthyReal(),
      persistence: { configured: true, reachable: true, status: 200, latencyMs: 12 },
    });
    expect(statusOf(r, "persistence")).toBe("ok");
    expect(r.checks.find((c) => c.name === "persistence")?.detail).toContain("no rev yet");
  });
});

describe("buildHealthReport — degraded-but-running warnings", () => {
  it("warns, not fails, when real-mode x402 has no treasury: bets fail closed, which is safe", () => {
    const r = buildHealthReport({ ...healthyReal(), x402: { payToConfigured: false, legacyOptIn: false } });
    expect(statusOf(r, "x402")).toBe("warn");
    expect(r.status).toBe("ok");
  });

  it("warns when the weaker legacy x402 opt-in is carrying real mode", () => {
    const r = buildHealthReport({ ...healthyReal(), x402: { payToConfigured: false, legacyOptIn: true } });
    expect(r.checks.find((c) => c.name === "x402")?.detail).toContain("legacy");
    expect(statusOf(r, "x402")).toBe("warn");
  });

  it("warns when the oracle shares the bettor key (single custody)", () => {
    const r = buildHealthReport({
      ...healthyReal(),
      signer: { bettorKeyConfigured: true, oracleKeyConfigured: false },
    });
    expect(statusOf(r, "signer.oracle")).toBe("warn");
    expect(r.status).toBe("ok");
  });

  it("warns when real mode runs without KV — boards die on every cold start", () => {
    const r = buildHealthReport({ ...healthyReal(), persistence: { configured: false, reachable: false } });
    expect(statusOf(r, "persistence")).toBe("warn");
  });

  it("warns when vault v2 is missing — creation would fall back to per-market installs", () => {
    const r = buildHealthReport({
      ...healthyReal(),
      contracts: { ...healthyReal().contracts, vaultV2: undefined },
    });
    expect(statusOf(r, "contracts.vaultV2")).toBe("warn");
    expect(statusOf(r, "contracts.routing")).toBe("ok"); // v1 vault still routes
  });
});

describe("buildHealthReport — fleet funding", () => {
  it("is ok when every purse clears the turn floor, and marks each funded", () => {
    const r = buildHealthReport(healthyReal());
    expect(statusOf(r, "fleet")).toBe("ok");
    expect(r.fleet.every((f) => f.funded)).toBe(true);
  });

  it("warns when some agents are sitting rounds out, and names them", () => {
    const base = healthyReal();
    const r = buildHealthReport({
      ...base,
      fleet: [base.fleet[0], { ...base.fleet[1], balanceMotes: "1" }],
    });
    expect(statusOf(r, "fleet")).toBe("warn");
    expect(r.checks.find((c) => c.name === "fleet")?.detail).toContain("Contrarian");
    expect(r.fleet.find((f) => f.agentId === "Contrarian")?.funded).toBe(false);
    expect(r.status).toBe("ok"); // a partly-funded fleet still bets
  });

  it("fails when every purse is empty — the fleet has stopped entirely", () => {
    const base = healthyReal();
    const r = buildHealthReport({ ...base, fleet: base.fleet.map((f) => ({ ...f, balanceMotes: "0" })) });
    expect(statusOf(r, "fleet")).toBe("fail");
    expect(r.status).toBe("degraded");
  });

  it("treats a balance exactly at the floor as funded (an agent can afford its turn)", () => {
    const base = healthyReal();
    const r = buildHealthReport({
      ...base,
      fleet: [{ ...base.fleet[0], balanceMotes: base.fleetMinBalanceMotes }],
    });
    expect(statusOf(r, "fleet")).toBe("ok");
  });

  it("skips when no fleet wallet is wired", () => {
    const r = buildHealthReport({ ...healthyReal(), fleet: [] });
    expect(statusOf(r, "fleet")).toBe("skip");
  });
});

describe("buildHealthReport — operator treasury funding", () => {
  // The purse the fleet check does not cover: it signs and funds every escrow, and it ran to
  // zero in production while `fleet` read green — three bets paid for and never placed.
  it("is ok with runway above every cadence floor", () => {
    const r = buildHealthReport(healthyReal());
    expect(statusOf(r, "treasury")).toBe("ok");
  });

  it("fails below the betting floor and names the account to refill", () => {
    const base = healthyReal();
    const r = buildHealthReport({
      ...base,
      treasury: { ...base.treasury!, balanceMotes: "0" },
    });
    expect(statusOf(r, "treasury")).toBe("fail");
    expect(r.status).toBe("degraded");
    expect(r.checks.find((c) => c.name === "treasury")?.detail).toContain("01cc");
  });

  it("warns between the betting floor and full cadence — bets fund, creation/seeding throttle", () => {
    const base = healthyReal();
    // 20 rounds: above BETTING_FLOOR_ROUNDS (12), below CREATION_FLOOR_ROUNDS (48).
    const r = buildHealthReport({
      ...base,
      treasury: { ...base.treasury!, balanceMotes: "100000000000" },
    });
    expect(statusOf(r, "treasury")).toBe("warn");
    expect(r.status).toBe("ok");
  });

  it("skips when the balance was not read, and in mock mode is absent entirely", () => {
    const noRead = buildHealthReport({ ...healthyReal(), treasury: undefined });
    expect(statusOf(noRead, "treasury")).toBe("skip");
    const mock = buildHealthReport({ ...healthyReal(), chainMode: "mock", treasury: undefined });
    expect(mock.checks.find((c) => c.name === "treasury")).toBeUndefined();
  });
});

describe("buildHealthReport — economy freshness", () => {
  it("is ok inside the stale window", () => {
    const r = buildHealthReport({
      ...healthyReal(),
      economy: { actionCount: 3, newestActionTs: NOW - (TICK_STALE_MS - 60_000) },
    });
    expect(statusOf(r, "economy")).toBe("ok");
  });

  it("warns once two ticks have been missed", () => {
    const r = buildHealthReport({
      ...healthyReal(),
      economy: { actionCount: 3, newestActionTs: NOW - (TICK_STALE_MS + 60_000) },
    });
    expect(statusOf(r, "economy")).toBe("warn");
    expect(r.economy.ageMs).toBe(TICK_STALE_MS + 60_000);
  });

  it("warns on a cold instance with no recorded activity", () => {
    const r = buildHealthReport({ ...healthyReal(), economy: { actionCount: 0, newestActionTs: null } });
    expect(statusOf(r, "economy")).toBe("warn");
    expect(r.economy.ageMs).toBeNull();
  });
});

describe("probePersistence", () => {
  beforeEach(() => {
    __resetPersistenceForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetPersistenceForTests();
  });

  it("reports unconfigured without touching the network", async () => {
    const spy = vi.fn();
    const res = await probePersistence(spy as unknown as typeof fetch);
    expect(res).toEqual({ configured: false, reachable: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports reachable on a 200 and never returns the url or token", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://kv.example.com");
    vi.stubEnv("KV_REST_API_TOKEN", "super-secret-token");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: null }), { status: 200 }));
    const res = await probePersistence(fetchImpl as unknown as typeof fetch);
    expect(res.configured).toBe(true);
    expect(res.reachable).toBe(true);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res)).not.toContain("super-secret-token");
    expect(JSON.stringify(res)).not.toContain("kv.example.com");
  });

  it("reports unreachable on a 401 rather than throwing", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://kv.example.com");
    vi.stubEnv("KV_REST_API_TOKEN", "rotated");
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const res = await probePersistence(fetchImpl as unknown as typeof fetch);
    expect(res).toMatchObject({ configured: true, reachable: false, status: 401 });
  });

  it("survives a transport failure", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://kv.example.com");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t");
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await probePersistence(fetchImpl as unknown as typeof fetch);
    expect(res.configured).toBe(true);
    expect(res.reachable).toBe(false);
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("surfaces the stored envelope's rev so CAS progress is observable from outside", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://kv.example.com");
    vi.stubEnv("KV_REST_API_TOKEN", "t");
    const stored = JSON.stringify({ v: 1, rev: 7, savedAt: "2026-07-20T00:00:00.000Z" });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: stored }), { status: 200 }));
    const res = await probePersistence(fetchImpl as unknown as typeof fetch);
    expect(res).toMatchObject({ configured: true, reachable: true, rev: 7 });
  });

  it("leaves rev undefined for an empty, pre-rev, or unparseable envelope — never throws", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://kv.example.com");
    vi.stubEnv("KV_REST_API_TOKEN", "t");
    for (const result of [null, "{not json", JSON.stringify({ v: 1, savedAt: "x" }), "[]"]) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result }), { status: 200 }));
      const res = await probePersistence(fetchImpl as unknown as typeof fetch);
      expect(res.reachable).toBe(true);
      expect(res.rev).toBeUndefined();
    }
  });
});

describe("gatherHealth", () => {
  beforeEach(() => {
    __resetActivity();
    __resetDemoSeed();
    __resetPersistenceForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetActivity();
    __resetDemoSeed();
  });

  it("does not seed the demo feed just by being observed", async () => {
    const r = await gatherHealth("testnet", { now: NOW });
    expect(r.economy.actionCount).toBe(0);
    // If gathering had gone through listActions(), the cold-start demo seed would have fired.
    const { exportActivityState } = await import("@/adapters/mock/activity-log");
    expect(exportActivityState().actions).toEqual([]);
  });

  it("counts real recorded activity and dates it from the newest action", async () => {
    appendAction({ agent: "Momentum", kind: "bet_placed", marketId: "m", ts: NOW - 30_000 });
    appendAction({ agent: "Arbiter", kind: "market_resolved", marketId: "m", ts: NOW - 5_000 });
    const r = await gatherHealth("testnet", { now: NOW });
    expect(r.economy.actionCount).toBe(2);
    expect(r.economy.newestActionTs).toBe(NOW - 5_000);
  });

  it("reads configuration presence, never configuration values", async () => {
    vi.stubEnv("CASPER_X402_PAYTO", "account-hash-deadbeef");
    vi.stubEnv("CASPER_BETTOR_KEY", "-----BEGIN PRIVATE KEY-----secret");
    const r = await gatherHealth("testnet", { now: NOW });
    const body = JSON.stringify(r);
    expect(body).not.toContain("deadbeef");
    expect(body).not.toContain("BEGIN PRIVATE KEY");
  });
});

describe("GET /api/health", () => {
  beforeEach(() => {
    __resetActivity();
    __resetDemoSeed();
    __resetPersistenceForTests();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetActivity();
    __resetDemoSeed();
  });

  it("returns 200 and no-store on a healthy (mock) deployment", async () => {
    const res = await healthGET(new Request("http://localhost/api/health?network=testnet"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.network).toBe("testnet");
    expect(json.simulated).toBe(true);
  });

  it("returns 503 when a check fails, so a monitor pages without parsing the body", async () => {
    vi.stubEnv("CASPER_CHAIN_MODE", "real"); // real mode with nothing else wired
    const res = await healthGET(new Request("http://localhost/api/health"));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.status).toBe("degraded");
    expect(json.problems).toContain("cron");
    expect(json.problems).toContain("signer.bettor");
  });

  it("falls back to the default network on a bogus ?network=", async () => {
    const res = await healthGET(new Request("http://localhost/api/health?network=solana"));
    expect((await res.json()).network).toBe("testnet");
  });
});

/**
 * Health's "is this purse funded?" and the cadence planner's "may this agent bet?" must be the
 * same number. They drifted once — health billed a turn at the base stake while the planner billed
 * Momentum's doubled conviction bet — so an operator could read every purse funded on a fleet the
 * planner had already throttled out of betting. Structurally one function now; this pins the value.
 */
describe("the fleet turn floor is the cadence planner's number", () => {
  it("covers the worst turn any Prophet can take: largest stake at full conviction, plus its gas", () => {
    const largest = PROPHETS.reduce((max, p) => Math.max(max, p.stakeCspr), 0);
    // The ESCROW gas, not the transfer gas. Since S30 a self-custodial agent signs the payable
    // `bet` session itself, which is the expensive half of its turn — an order of magnitude above
    // the native transfer it replaced. Billing a turn at the old floor would call a purse funded
    // that cannot actually pay for the escrow it is about to submit.
    const worstCase =
      BigInt(csprToMotes(largest)) * BigInt(MAX_CONVICTION_MULTIPLIER) + PROPHET_ESCROW_GAS_FLOOR_MOTES;
    expect(fleetTurnFloorMotes()).toBe(worstCase.toString());
    expect(fleetTurnFloorMotes()).toBe(prophetTurnCostMotes());
  });

  it("bills the escrow gas, which is strictly more than the transfer gas it replaced", () => {
    expect(PROPHET_ESCROW_GAS_FLOOR_MOTES).toBeGreaterThan(PROPHET_GAS_FLOOR_MOTES);
  });

  it("stays above the chain's own transfer floor — a turn that cannot transfer is not a turn", () => {
    expect(BigInt(fleetTurnFloorMotes())).toBeGreaterThan(NATIVE_TRANSFER_MINIMUM_MOTES);
  });
});

/**
 * The paid-but-not-placed breaker on the health surface. This is the check that would have caught
 * the real incident: agents paying the treasury every tick and getting no bet, for hours, while
 * every other check stayed green.
 */
describe("the paid-but-not-placed breaker check", () => {
  it("is ok while every paid bet lands", () => {
    const r = buildHealthReport(healthyReal());
    expect(r.checks.find((c) => c.name === "bets")!.status).toBe("ok");
  });

  it("warns on failures that have not yet tripped it", () => {
    const r = buildHealthReport({
      ...healthyReal(),
      breaker: { consecutiveFailures: 2, trippedAt: null, lastFailureReason: "413 Payload Too Large" },
    });
    const c = r.checks.find((x) => x.name === "bets")!;
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("413 Payload Too Large");
  });

  it("FAILS the whole report once tripped — money is being lost for nothing", () => {
    const r = buildHealthReport({
      ...healthyReal(),
      breaker: { consecutiveFailures: 3, trippedAt: 1_700_000_000_000, lastFailureReason: "chain submission failed" },
    });
    const c = r.checks.find((x) => x.name === "bets")!;
    expect(c.status).toBe("fail");
    expect(r.status).toBe("degraded"); // a monitor pages someone
    expect(c.detail).toMatch(/resetBreaker/);
  });

  it("skips when nothing tracks it, rather than claiming health it cannot see", () => {
    const withoutBreaker = { ...healthyReal() };
    delete (withoutBreaker as { breaker?: unknown }).breaker;
    expect(buildHealthReport(withoutBreaker).checks.find((c) => c.name === "bets")!.status).toBe("skip");
  });
});

describe("the quarantined-markets check", () => {
  it("is ok when every catalogued market is bettable", () => {
    expect(buildHealthReport(healthyReal()).checks.find((c) => c.name === "markets")!.status).toBe("ok");
  });

  it("warns — the economy is fine, but the catalogue is quietly smaller than it looks", () => {
    const r = buildHealthReport({
      ...healthyReal(),
      quarantinedMarkets: [{ slug: "coin-flip-5m", reason: "UnknownOutcome: User error: 3" }],
    });
    const c = r.checks.find((x) => x.name === "markets")!;
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("coin-flip-5m");
    expect(r.status).toBe("ok"); // a warn must not page anyone at 3am
  });
});

describe("the wallet check judges the app id's reality, not just its presence", () => {
  const armed = (appIdCheck?: { status: "accepted" | "rejected" | "unreachable"; detail?: string }) =>
    buildHealthReport({ ...healthyReal(), wallet: { posture: "armed" as const, appIdCheck } });

  it("FAILS when CSPR.click rejects the configured id — every visitor's SDK is crashing on it", () => {
    const r = armed({ status: "rejected", detail: "401 wrong application id" });
    const c = r.checks.find((x) => x.name === "wallet")!;
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("wrong application id");
    expect(c.detail).toContain("console.cspr.click");
    expect(r.status).toBe("degraded"); // a green report over a dead wallet is how this shipped broken
  });

  it("is ok — and says verified — when accounts.cspr.click accepted the id", () => {
    const c = armed({ status: "accepted" }).checks.find((x) => x.name === "wallet")!;
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("accepted");
  });

  it("gives an unreachable probe the benefit of the doubt — their outage is not our misconfig", () => {
    expect(armed({ status: "unreachable" }).checks.find((x) => x.name === "wallet")!.status).toBe("ok");
    expect(armed(undefined).checks.find((x) => x.name === "wallet")!.status).toBe("ok");
  });
});

/**
 * Human market creation. Both of these made the create page reject everyone with no way to tell a
 * broken deployment from bad input — which is how an unpayable bond stayed live.
 */
describe("creation health", () => {
  function creationCheck(i: HealthInputs) {
    return buildHealthReport(i).checks.find((c) => c.name === "creation");
  }

  it("is ok when the bond is transferable and an oracle is approved", () => {
    expect(creationCheck(healthyReal())?.status).toBe("ok");
  });

  it("fails when the configured bond is below the chainspec transfer floor", () => {
    const i: HealthInputs = {
      ...healthyReal(),
      creation: { bondBlocker: "below the native-transfer minimum", oracleAccountConfigured: true },
    };
    const report = buildHealthReport(i);
    expect(creationCheck(i)?.status).toBe("fail");
    expect(report.problems).toContain("creation");
  });

  it("fails when no approved oracle account is configured — nothing can be bound", () => {
    const i: HealthInputs = {
      ...healthyReal(),
      creation: { bondBlocker: null, oracleAccountConfigured: false },
    };
    expect(creationCheck(i)?.status).toBe("fail");
    expect(creationCheck(i)?.detail).toMatch(/CASPER_ORACLE_ACCOUNT/);
  });

  it("is skipped in mock mode and absent for a caller that does not report it", () => {
    expect(creationCheck({ ...healthyReal(), chainMode: "mock" })?.status).toBe("skip");
    const withoutCreation = { ...healthyReal(), creation: undefined };
    expect(creationCheck(withoutCreation)).toBeUndefined();
  });
});

/**
 * Bonded agent identity (S33/W2).
 *
 * The registry is the difference between "any Casper agent can join" as an HTTP claim and as an
 * on-chain fact. It warns rather than fails when absent — the economy runs fine without it — but
 * an operator reading a green board must not have to infer the gap from a missing check.
 */
describe("the AgentRegistry check", () => {
  it("is ok when the registry is wired", () => {
    expect(statusOf(buildHealthReport(healthyReal()), "contracts.agentRegistry")).toBe("ok");
  });

  it("warns, not fails, when it is not — the economy still runs", () => {
    const base = healthyReal();
    const report = buildHealthReport({
      ...base,
      contracts: { ...base.contracts, agentRegistry: undefined },
    });
    expect(statusOf(report, "contracts.agentRegistry")).toBe("warn");
    expect(report.status).toBe("ok"); // a warn must not degrade the deployment
  });

  it("names the command that fixes it", () => {
    const base = healthyReal();
    const report = buildHealthReport({
      ...base,
      contracts: { ...base.contracts, agentRegistry: undefined },
    });
    const detail = report.checks.find((c) => c.name === "contracts.agentRegistry")!.detail;
    expect(detail).toContain("registry-deploy");
    expect(detail).toContain("NEXT_PUBLIC_<NETWORK>_AGENT_REGISTRY");
  });
});
