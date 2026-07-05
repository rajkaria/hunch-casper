/**
 * The cold-start demo seed makes `/agents` and `/markets` show a live-looking economy on a fresh
 * serverless instance (between cron ticks) instead of empty states. It is guarded OFF under test, so
 * here we temporarily lift the guard to prove it produces a coherent, engine-consistent board.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ensureDemoSeed, __resetDemoSeed } from "@/adapters/mock/demo-seed";
import { listActions, __resetActivity } from "@/adapters/mock/activity-log";
import { ledgerSettledEntries, __resetLedger } from "@/adapters/mock/settlement-ledger";
import { computeAgentLeaderboard } from "@/core/agent-leaderboard";
import { __resetOracleLedger, oracleReputationOf } from "@/adapters/mock/oracle-ledger";

beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetDemoSeed();
  // The seed self-guards with NODE_ENV === "test"; lift it so we can exercise the seeder.
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetDemoSeed();
});

describe("demo seed", () => {
  it("populates a coherent activity feed + Agent PnL board (all four Prophets, a real winner & loser)", () => {
    ensureDemoSeed("testnet");

    expect(listActions().length).toBeGreaterThan(0);

    const board = computeAgentLeaderboard(ledgerSettledEntries("testnet"));
    expect(board.length).toBe(4); // every Prophet has settled activity
    expect(board.some((a) => BigInt(a.realizedPnlMotes) > 0n)).toBe(true); // someone won
    expect(board.some((a) => BigInt(a.realizedPnlMotes) < 0n)).toBe(true); // someone lost

    // The Arbiter recorded on-chain resolutions beyond its seeded baseline.
    expect(oracleReputationOf("arbiter").resolved).toBeGreaterThan(128);
  });

  it("is idempotent — re-seeding does not double-count", () => {
    ensureDemoSeed("testnet");
    const first = ledgerSettledEntries("testnet").length;
    ensureDemoSeed("testnet");
    expect(ledgerSettledEntries("testnet").length).toBe(first);
  });
});
