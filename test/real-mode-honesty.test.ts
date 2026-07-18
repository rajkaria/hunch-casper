/**
 * The `simulated` chip's extinction on the testnet surface — the S17 gate.
 *
 * "Extinct" here means something precise, and narrower than "never appears": **no real-mode action
 * backed by a real transaction may be labelled simulated, and no action lacking a transaction may
 * be labelled real.** The chip stays in the codebase forever (invariant 5 of the roadmap:
 * *anything simulated is labelled, forever*) — what changes is that on a correctly configured
 * real-mode deployment nothing produces one.
 *
 * These tests pin both directions, because getting one right and the other wrong is worse than
 * failing openly: an action linking a pseudo-hash to cspr.live sends a visitor to "transaction not
 * found", and an unlabelled fabrication is simply a lie.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createContainer, type Container } from "@/lib/container";
import { runGenesis } from "@/agent/genesis";
import { runProphetFleet } from "@/agent/prophet";
import { seedMarketPools, scaleSeedPools, HOUSE_BETTOR, DEFAULT_HOUSE_SEED_DIVISOR } from "@/agent/house-seed";
import { ensureDemoSeed, __resetDemoSeed } from "@/adapters/mock/demo-seed";
import { listActions, __resetActivity } from "@/adapters/mock/activity-log";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { addCreatedMarket, __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { __resetMockWallet } from "@/adapters/mock/mock-wallet";
import { createMockChain } from "@/adapters/mock/mock-chain";
import { computeAgentLeaderboard } from "@/core/agent-leaderboard";
import type { MarketDefinition } from "@/core/catalogue";

const TRIGGER = {
  metric: "cspr_usd",
  value: "0.0421",
  unitLabel: "$",
  deadlineIso: "2026-08-01T00:00:00.000Z",
  seq: 0,
};

beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetConsumedNonces();
  __resetCreatedMarkets();
  __resetMockWallet();
  __resetDemoSeed();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetDemoSeed();
});

/** Real mode with everything a Genesis creation needs, minus the parts that need a live node. */
function stubRealMode(): void {
  vi.stubEnv("CASPER_CHAIN_MODE", "real");
  vi.stubEnv("CASPER_ORACLE_ACCOUNT", "account-hash-" + "53".repeat(32));
  // Opens the real-mode agent rail on the legacy nonce-match verifier, so the fleet can bet here
  // without a live node to verify transfers against. Payment verification has its own suite; what
  // is under test here is which label an agent attaches to a receipt.
  vi.stubEnv("CASPER_REAL_AGENT_X402", "true");
}

/**
 * A real-mode container whose chain adapter is the deterministic mock. CI has no node, and the
 * question under test is not "can we reach Casper" — it is "given a receipt, does the agent label
 * the action honestly". Swapping the adapter isolates exactly that.
 */
function realModeContainer(): Container {
  return { ...createContainer("testnet"), chain: createMockChain("testnet") };
}

describe("Genesis labels a creation by whether a transaction backs it", () => {
  it("mock mode: no transaction, so the action is labelled simulated and carries no explorer link", async () => {
    const container = realModeContainer();
    await runGenesis(container, TRIGGER);
    const created = listActions().find((a) => a.kind === "market_created");
    expect(created?.simulated).toBe(true);
    expect(created?.deployHash).toBeUndefined();
    expect(created?.explorerUrl).toBeUndefined();
  });

  it("real mode with a receipt: labelled real, and the explorer link points at that transaction", async () => {
    stubRealMode();
    const container = realModeContainer();
    await runGenesis(container, TRIGGER, { houseSeed: false });
    const created = listActions().find((a) => a.kind === "market_created");
    expect(created?.simulated).toBe(false);
    expect(created?.deployHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created?.explorerUrl).toContain(created!.deployHash!);
  });

  it("real mode without an oracle account: falls back to a LABELLED simulation, never silent success", async () => {
    // The vault binds an approved, non-creator oracle to every market; there is no safe default,
    // so a missing one must degrade visibly rather than invent an address.
    vi.stubEnv("CASPER_CHAIN_MODE", "real");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const container = realModeContainer();
    await runGenesis(container, TRIGGER);
    const created = listActions().find((a) => a.kind === "market_created");
    expect(created?.simulated).toBe(true);
    expect(created?.deployHash).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("real mode with a failing chain: still opens the market, still labels it simulated", async () => {
    stubRealMode();
    const base = realModeContainer();
    const container: Container = {
      ...base,
      chain: {
        ...base.chain,
        createMarket: async () => {
          throw new Error("node unreachable");
        },
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const market = await runGenesis(container, TRIGGER);
    expect(market.slug.length).toBeGreaterThan(0); // the economy keeps running
    expect(listActions().find((a) => a.kind === "market_created")?.simulated).toBe(true);
    warn.mockRestore();
  });
});

describe("no real-mode path fabricates activity", () => {
  it("the demo seed refuses to run in real mode", () => {
    stubRealMode();
    ensureDemoSeed("testnet");
    expect(listActions().filter((a) => a.simulated)).toHaveLength(0);
  });

  it("a full real-mode round produces only explorer-linkable actions", async () => {
    stubRealMode();
    const container = realModeContainer();
    await runGenesis(container, TRIGGER, { houseSeed: false });
    await runProphetFleet(container, 0);

    const actions = listActions();
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.simulated).toBe(false);
      expect(action.deployHash).toMatch(/^[0-9a-f]{64}$/);
      expect(action.explorerUrl).toContain("cspr.live");
    }
  });

  it("never links a simulated action to the live explorer", async () => {
    // A pseudo hash on cspr.live lands a visitor on "transaction not found" — worse than no link.
    const container = realModeContainer();
    await runGenesis(container, TRIGGER);
    for (const action of listActions()) {
      if (action.simulated) expect(action.explorerUrl).toBeUndefined();
    }
  });
});

describe("house seeding", () => {
  const DEF: MarketDefinition = {
    slug: "house-seed-fixture",
    title: "Fixture",
    subtitle: "Fixture",
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
      description: "fixture",
    },
    deadlineIso: "2026-08-01T00:00:00.000Z",
    seedPoolMotes: { yes: "1200000000000", no: "800000000000" },
  };

  it("preserves the catalogue ratio when scaling down — the seed pools ARE the opening odds", () => {
    const scaled = scaleSeedPools(DEF.seedPoolMotes, 500);
    const yes = BigInt(scaled.find((s) => s.outcomeKey === "yes")!.amountMotes);
    const no = BigInt(scaled.find((s) => s.outcomeKey === "no")!.amountMotes);
    expect(yes * 800n).toBe(no * 1200n); // 1200:800 preserved exactly
  });

  it("drops an outcome that rounds to zero rather than bumping it to a token stake", () => {
    // A one-mote stake would distort the very ratio the scaling is meant to preserve.
    expect(scaleSeedPools({ yes: "100", no: "1000000" }, 1000)).toEqual([
      { outcomeKey: "no", amountMotes: "1000" },
    ]);
  });

  it("ignores malformed pools instead of throwing mid-creation", () => {
    expect(scaleSeedPools({ yes: "not-a-number" }, 10)).toEqual([]);
    expect(scaleSeedPools(undefined, 10)).toEqual([]);
  });

  it("stakes real, explorer-linkable liquidity — a house seed is labelled, not fake", async () => {
    stubRealMode();
    const container = realModeContainer();
    addCreatedMarket(DEF); // seeding always follows registration, as in `runGenesis`
    const actions = await seedMarketPools(container, DEF, "testnet:house-seed-fixture");
    expect(actions.length).toBe(2);
    for (const a of actions) {
      expect(a.simulated).toBe(false);
      expect(a.agent).toBe("House");
      expect(a.narration).toContain("House seed");
    }
  });

  it("keeps house liquidity off the agent PnL board", async () => {
    stubRealMode();
    const container = realModeContainer();
    await seedMarketPools(container, DEF, "testnet:house-seed-fixture");
    const board = computeAgentLeaderboard(await container.store.settledEntries("testnet"));
    expect(board.some((row) => row.agent === HOUSE_BETTOR)).toBe(false);
  });

  it("survives a failed seed rather than unwinding a creation that already landed on chain", async () => {
    stubRealMode();
    const base = realModeContainer();
    const container: Container = {
      ...base,
      chain: {
        ...base.chain,
        placeBet: async () => {
          throw new Error("node unreachable");
        },
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(seedMarketPools(container, DEF, "testnet:house-seed-fixture")).resolves.toEqual([]);
    warn.mockRestore();
  });

  it("defaults to a divisor that makes seeding affordable per market", () => {
    // ~1 CSPR a side out of the catalogue's ~500 CSPR demo pools.
    expect(DEFAULT_HOUSE_SEED_DIVISOR).toBe(500);
  });
});
