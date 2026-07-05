/**
 * Demo-surface abuse guards — the creation cap + trigger cooldown that stop a griefer spamming
 * the PUBLIC demo endpoints (POST /api/agent/genesis/run is unauthenticated in mock mode) and
 * polluting the judged catalogue. Pure helpers first, then the genesis route wiring. The guards
 * are skipped under NODE_ENV=test unless a test opts in via ABUSE_GUARDS=on, so the route tests
 * here exercise them deterministically while every other suite stays untouched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  genesisCapReached,
  cooldown,
  TRIGGER_LAST_RUN,
  __resetAbuseGuards,
} from "@/lib/abuse-guards";
import { listCreatedMarkets, __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { POST as genesisPOST } from "@/app/api/agent/genesis/run/route";

afterEach(() => {
  vi.unstubAllEnvs();
  __resetAbuseGuards();
});

describe("genesisCapReached", () => {
  it("defaults the cap to 12", () => {
    expect(genesisCapReached(11)).toBe(false);
    expect(genesisCapReached(12)).toBe(true);
    expect(genesisCapReached(13)).toBe(true);
  });

  it("reads the cap from GENESIS_MAX_CREATED", () => {
    vi.stubEnv("GENESIS_MAX_CREATED", "3");
    expect(genesisCapReached(2)).toBe(false);
    expect(genesisCapReached(3)).toBe(true);
  });

  it("an explicit cap argument wins over the env", () => {
    vi.stubEnv("GENESIS_MAX_CREATED", "3");
    expect(genesisCapReached(3, 5)).toBe(false);
    expect(genesisCapReached(5, 5)).toBe(true);
  });

  it("falls back to 12 on a malformed env value", () => {
    vi.stubEnv("GENESIS_MAX_CREATED", "not-a-number");
    expect(genesisCapReached(11)).toBe(false);
    expect(genesisCapReached(12)).toBe(true);
  });
});

describe("cooldown", () => {
  it("allows the first call, blocks within the interval, allows again after it", () => {
    const lastRun = new Map<string, number>();
    expect(cooldown("genesis", 1_000, 20_000, lastRun)).toBe(0); // first: allowed + recorded
    expect(cooldown("genesis", 6_000, 20_000, lastRun)).toBe(15_000); // blocked: 15s remain
    expect(cooldown("genesis", 20_999, 20_000, lastRun)).toBe(1); // still 1ms short
    expect(cooldown("genesis", 21_000, 20_000, lastRun)).toBe(0); // interval elapsed: allowed
    expect(cooldown("genesis", 22_000, 20_000, lastRun)).toBe(19_000); // re-recorded at 21s
  });

  it("tracks keys independently", () => {
    const lastRun = new Map<string, number>();
    expect(cooldown("genesis", 1_000, 20_000, lastRun)).toBe(0);
    expect(cooldown("arbiter", 1_000, 20_000, lastRun)).toBe(0);
    expect(cooldown("genesis", 2_000, 20_000, lastRun)).toBeGreaterThan(0);
  });

  it("__resetAbuseGuards clears the module-level TRIGGER_LAST_RUN map", () => {
    expect(cooldown("genesis", 1_000, 20_000, TRIGGER_LAST_RUN)).toBe(0);
    expect(cooldown("genesis", 2_000, 20_000, TRIGGER_LAST_RUN)).toBeGreaterThan(0);
    __resetAbuseGuards();
    expect(TRIGGER_LAST_RUN.size).toBe(0);
    expect(cooldown("genesis", 3_000, 20_000, TRIGGER_LAST_RUN)).toBe(0);
  });
});

describe("POST /api/agent/genesis/run guards", () => {
  function fire(): Promise<Response> {
    return genesisPOST(
      new Request("http://localhost/api/agent/genesis/run", { method: "POST", body: "{}" }),
    );
  }

  beforeEach(() => {
    __resetCreatedMarkets();
    __resetLedger();
    __resetAbuseGuards();
  });

  afterEach(() => {
    __resetCreatedMarkets();
    __resetLedger();
  });

  it("skips both guards under test unless ABUSE_GUARDS=on (existing suites stay green)", async () => {
    expect((await fire()).status).toBe(200);
    expect((await fire()).status).toBe(200); // back-to-back: no cooldown, no cap
    expect(listCreatedMarkets().length).toBe(2);
  });

  it("409s once the catalogue cap is reached", async () => {
    vi.stubEnv("ABUSE_GUARDS", "on");
    vi.stubEnv("GENESIS_MAX_CREATED", "1");
    expect((await fire()).status).toBe(200); // fills the 1-market cap
    const res = await fire();
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/cap reached/);
    expect(listCreatedMarkets().length).toBe(1); // nothing created past the cap
  });

  it("429s within the 20s cooldown with a ceiled retry-after header", async () => {
    vi.stubEnv("ABUSE_GUARDS", "on");
    expect((await fire()).status).toBe(200); // arms the cooldown
    const res = await fire();
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(20);
    expect((await res.json()).error).toMatch(/cooldown/);
    expect(listCreatedMarkets().length).toBe(1); // the blocked call created nothing

    __resetAbuseGuards(); // deterministic "20s later" without wall-clock waits
    expect((await fire()).status).toBe(200);
  });
});
