import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockMarketStore } from "@/adapters/mock/mock-market-store";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";

const store = createMockMarketStore();
const BTC = "testnet:btc-150k-aug"; // seed: yes 700 CSPR, no 2300 CSPR, deadline 2026-08-01

beforeEach(__resetLedger);
afterEach(() => vi.useRealTimers());

describe("settlement store — recording bets", () => {
  it("grows the outcome pool and the total on a bet", async () => {
    const before = await store.get("btc-150k-aug", "testnet");
    expect(before!.poolByOutcomeMotes.yes).toBe("700000000000");

    const after = await store.recordBet({
      marketId: BTC,
      bettor: "agent:momentum",
      outcomeKey: "yes",
      amountMotes: "300000000000", // +300 CSPR
    });
    expect(after.poolByOutcomeMotes.yes).toBe("1000000000000");
    expect(after.totalStakedMotes).toBe("3300000000000"); // 3000 seed + 300

    const live = await store.get("btc-150k-aug", "testnet");
    expect(live!.poolByOutcomeMotes.yes).toBe("1000000000000");
  });

  it("rejects a bet on an unknown outcome or an unknown market", async () => {
    await expect(
      store.recordBet({ marketId: BTC, bettor: "x", outcomeKey: "maybe", amountMotes: "1" }),
    ).rejects.toThrow(/not an outcome/);
    await expect(
      store.recordBet({ marketId: "testnet:nope", bettor: "x", outcomeKey: "yes", amountMotes: "1" }),
    ).rejects.toThrow(/unknown market/);
  });
});

describe("settlement store — settling through the payout engine", () => {
  it("pays the winning bettor and is conservation-correct with seed liquidity", async () => {
    // Alice adds 300 CSPR on YES (seed already 700 YES / 2300 NO).
    await store.recordBet({ marketId: BTC, bettor: "alice", outcomeKey: "yes", amountMotes: "300000000000" });
    const record = await store.settle(BTC, "yes");

    expect(record.status).toBe("resolved");
    expect(record.manifest).not.toBeNull();
    const m = record.manifest!;
    // Conservation: winners + fee + dust == total pool.
    const paid = Object.values(m.payouts).reduce((s, v) => s + BigInt(v), 0n);
    expect(paid + BigInt(m.feeMotes) + BigInt(m.dustMotes)).toBe(BigInt(m.totalPoolMotes));
    // Alice bet the winning side → she is paid at least her stake.
    expect(BigInt(m.payouts.alice) >= 300000000000n).toBe(true);
    // The house liquidity that backed YES is also paid (it's a real participant).
    expect(m.payouts["house:liquidity"]).toBeDefined();
  });

  it("closes betting once settled and is idempotent", async () => {
    await store.settle(BTC, "yes");
    await expect(
      store.recordBet({ marketId: BTC, bettor: "late", outcomeKey: "yes", amountMotes: "1" }),
    ).rejects.toThrow(/betting is closed/);
    // Re-settling returns the existing record, not a fresh computation.
    const again = await store.settle(BTC, "no");
    expect(again.winningOutcomeKey).toBe("yes"); // first settlement stands
  });

  it("voids a round when asked, refunding everyone their full stake", async () => {
    await store.recordBet({ marketId: BTC, bettor: "alice", outcomeKey: "yes", amountMotes: "100" });
    const record = await store.settle(BTC, null);
    expect(record.status).toBe("void");
    const m = record.manifest!;
    expect(m.feeMotes).toBe("0");
    // Refunds sum exactly to the pool (no fee, no dust).
    const paid = Object.values(m.payouts).reduce((s, v) => s + BigInt(v), 0n);
    expect(paid).toBe(BigInt(m.totalPoolMotes));
  });

  it("reports settlement state via settlementFor", async () => {
    expect(await store.settlementFor(BTC)).toBeNull();
    await store.settle(BTC, "yes");
    expect((await store.settlementFor(BTC))!.status).toBe("resolved");
    expect(await store.settlementFor("testnet:nope")).toBeNull();
  });

  it("marks the market resolved with the winning outcome in the read model", async () => {
    await store.settle(BTC, "no");
    const live = await store.get("btc-150k-aug", "testnet");
    expect(live!.status).toBe("resolved");
    expect(live!.resolvedOutcomeKey).toBe("no");
  });
});

describe("settlement store — deadline lock", () => {
  it("locks the market and rejects bets once past the deadline (mirrors the vault)", async () => {
    // Freeze the clock a day after btc-150k-aug's 2026-08-01 deadline.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));

    const live = await store.get("btc-150k-aug", "testnet");
    expect(live!.status).toBe("locked");
    await expect(
      store.recordBet({ marketId: BTC, bettor: "late", outcomeKey: "yes", amountMotes: "1" }),
    ).rejects.toThrow(/betting is closed/);
  });

  it("stays open before the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    const live = await store.get("btc-150k-aug", "testnet");
    expect(live!.status).toBe("open");
  });
});
