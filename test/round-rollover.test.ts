import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { rollMaturedRounds, roundDefinitionFor } from "@/agent/round-rollover";
import { createMockClock } from "@/adapters/mock/mock-clock";
import { roundMarketId } from "@/core/round-id";
import { currentRound } from "@/core/round-schedule";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { findDefinition, __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { quarantineMarket, __resetQuarantine } from "@/agent/market-quarantine";

const NOW = Date.parse("2026-09-15T13:37:00.000Z");

function fakeContainer(createMarket?: ReturnType<typeof vi.fn>) {
  const created: string[] = [];
  const fn =
    createMarket ??
    vi.fn(async (input: { marketId: string }) => {
      created.push(input.marketId);
      return { deployHash: "0xabc", explorerUrl: "https://x" };
    });
  return {
    created,
    container: {
      network: "testnet" as const,
      clock: createMockClock(NOW),
      chain: { createMarket: fn },
    } as never,
  };
}

beforeEach(() => {
  __resetCreatedMarkets();
  __resetQuarantine();
});
afterEach(() => {
  __resetCreatedMarkets();
  __resetQuarantine();
});

describe("round rollover", () => {
  it("registers the current round of a recurring market", async () => {
    const { container } = fakeContainer();
    await rollMaturedRounds(container);
    const idx = currentRound("hourly", NOW)!.index;
    expect(findDefinition(roundMarketId("cspr-hourly-updown", idx))).toBeDefined();
  });

  it("is idempotent — a round already open is not opened twice", async () => {
    const { container } = fakeContainer();
    const first = await rollMaturedRounds(container);
    expect(first.length).toBeGreaterThan(0);
    const second = await rollMaturedRounds(container);
    expect(second).toEqual([]);
  });

  it("never rolls a quarantined market", async () => {
    quarantineMarket({ slug: "coin-flip-5m", reason: "UnknownOutcome", deployHash: "0x1", ts: NOW });
    const { container } = fakeContainer();
    const opened = await rollMaturedRounds(container);
    expect(opened.some((a) => a.marketId.includes("coin-flip-5m"))).toBe(false);
  });

  it("never rolls a one-shot market", async () => {
    const { container } = fakeContainer();
    const opened = await rollMaturedRounds(container);
    expect(opened.some((a) => a.marketId.includes("btc-150k-aug"))).toBe(false);
  });

  it("calls the chain in real mode, and labels the round non-simulated", async () => {
    vi.stubEnv("CASPER_CHAIN_MODE", "real");
    vi.stubEnv("CASPER_ORACLE_ACCOUNT", "account-hash-deadbeef");
    const { container, created } = fakeContainer();
    const opened = await rollMaturedRounds(container);
    expect(created.length).toBe(opened.length);
    expect(opened.every((a) => a.simulated === false)).toBe(true);
    vi.unstubAllEnvs();
  });

  it("refuses to open a round in real mode with no oracle account configured", async () => {
    vi.stubEnv("CASPER_CHAIN_MODE", "real");
    vi.stubEnv("CASPER_ORACLE_ACCOUNT", "");
    const { container, created } = fakeContainer();
    // An unresolvable round is worse than no round: the vault binds an approved, non-creator
    // oracle to every market, and nothing else may resolve it.
    expect(await rollMaturedRounds(container)).toEqual([]);
    expect(created).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("one market's creation failure does not abort the others", async () => {
    vi.stubEnv("CASPER_CHAIN_MODE", "real");
    vi.stubEnv("CASPER_ORACLE_ACCOUNT", "account-hash-deadbeef");
    const created: string[] = [];
    const failing = vi.fn(async (input: { marketId: string }) => {
      if (input.marketId.startsWith("coin-flip-5m")) throw new Error("revert");
      created.push(input.marketId);
      return { deployHash: "0xabc", explorerUrl: "https://x" };
    });
    const { container } = fakeContainer(failing);
    await expect(rollMaturedRounds(container)).resolves.toBeDefined();
    expect(created.length).toBeGreaterThan(0);
    expect(created.some((id) => id.startsWith("coin-flip-5m"))).toBe(false);
    vi.unstubAllEnvs();
  });

  it("a reverted create leaves no bettable round behind", async () => {
    vi.stubEnv("CASPER_CHAIN_MODE", "real");
    vi.stubEnv("CASPER_ORACLE_ACCOUNT", "account-hash-deadbeef");
    const alwaysFails = vi.fn(async () => {
      throw new Error("revert");
    });
    const { container } = fakeContainer(alwaysFails);
    await rollMaturedRounds(container);
    const idx = currentRound("hourly", NOW)!.index;
    // Registering before the chain confirmed would leave a market that looks bettable with no
    // escrow behind it — every stake placed on it would be unrecoverable.
    expect(findDefinition(roundMarketId("cspr-hourly-updown", idx))).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("a spawned round is itself one-shot, so it can actually mature", () => {
    // The trap this pins: if a round instance inherited the parent's cadence, its own deadline
    // would keep re-deriving forward and it would never lock — the original bug, one level down.
    const parent = MARKET_DEFINITIONS.find((d) => d.slug === "cspr-hourly-updown")!;
    const round = currentRound("hourly", NOW)!;
    const def = roundDefinitionFor(parent, round);
    expect(def.cadence).toBe("one-shot");
    expect(Date.parse(def.deadlineIso)).toBe(round.deadlineMs);
    expect(def.slug).toBe(roundMarketId(parent.slug, round.index));
  });

  it("a spawned round carries the parent's outcomes and fee verbatim", () => {
    const parent = MARKET_DEFINITIONS.find((d) => d.slug === "cspr-hourly-updown")!;
    const def = roundDefinitionFor(parent, currentRound("hourly", NOW)!);
    expect(def.outcomes).toEqual(parent.outcomes);
    expect(def.feeBps).toBe(parent.feeBps);
    expect(def.resolver).toEqual(parent.resolver);
  });
});
