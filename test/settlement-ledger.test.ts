import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockMarketStore } from "@/adapters/mock/mock-market-store";
import {
  __resetLedger,
  exportSettlementState,
  importSettlementState,
} from "@/adapters/mock/settlement-ledger";

const store = createMockMarketStore();
// btc-150k-aug matured on 2026-08-01 and is retired (a deadline is immutable on chain, so the row
// could only be succeeded, not extended). Its successor asks the same question of the same feed
// with a 2026-11-01 deadline, which keeps these cases testing what they meant to test: a LIVE book.
const BTC = "testnet:btc-70k-nov"; // deadline 2026-11-01, opens with empty pools

/**
 * Escrow the house launch liquidity the retired predecessor carried in its catalogue seed
 * (700 CSPR YES / 2300 CSPR NO). The successor cohort ships unseeded, so a case that needs a book
 * has to place it — which is what a faithful deployment does anyway (`MarketDeployPlan.seedBets`
 * escrows the house bets on chain at launch), and it keeps `house:liquidity` the ordinary staker
 * the payout engine settles it as.
 */
async function escrowHouseLiquidity(): Promise<void> {
  await store.recordBet({
    marketId: BTC,
    bettor: "house:liquidity",
    outcomeKey: "yes",
    amountMotes: "700000000000",
  });
  await store.recordBet({
    marketId: BTC,
    bettor: "house:liquidity",
    outcomeKey: "no",
    amountMotes: "2300000000000",
  });
}

beforeEach(__resetLedger);
afterEach(() => vi.useRealTimers());

describe("settlement store — recording bets", () => {
  beforeEach(escrowHouseLiquidity);

  it("grows the outcome pool and the total on a bet", async () => {
    const before = await store.get("btc-70k-nov", "testnet");
    expect(before!.poolByOutcomeMotes.yes).toBe("700000000000");

    const after = await store.recordBet({
      marketId: BTC,
      bettor: "agent:momentum",
      outcomeKey: "yes",
      amountMotes: "300000000000", // +300 CSPR
    });
    expect(after.poolByOutcomeMotes.yes).toBe("1000000000000");
    expect(after.totalStakedMotes).toBe("3300000000000"); // 3000 house + 300

    const live = await store.get("btc-70k-nov", "testnet");
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

  it("records a dedupeKey'd bet exactly once, however many times it is replayed", async () => {
    // The client polls `/api/chain/bet/confirm` until the transaction executes, so two polls can
    // both observe the same success. One transaction is one bet: without this the pools would
    // double-count a stake the chain only ever escrowed once.
    const first = await store.recordBet({
      marketId: BTC,
      bettor: "alice",
      outcomeKey: "yes",
      amountMotes: "300000000000",
      dedupeKey: "tx-abc",
    });
    expect(first.poolByOutcomeMotes.yes).toBe("1000000000000");

    const replay = await store.recordBet({
      marketId: BTC,
      bettor: "alice",
      outcomeKey: "yes",
      amountMotes: "300000000000",
      dedupeKey: "tx-abc",
    });
    expect(replay.poolByOutcomeMotes.yes).toBe("1000000000000");
    expect(replay.totalStakedMotes).toBe("3300000000000");

    // A DIFFERENT transaction is a different bet, even with identical terms.
    const second = await store.recordBet({
      marketId: BTC,
      bettor: "alice",
      outcomeKey: "yes",
      amountMotes: "300000000000",
      dedupeKey: "tx-def",
    });
    expect(second.poolByOutcomeMotes.yes).toBe("1300000000000");
  });

  it("keeps deduping across a snapshot round trip — instances must agree on 'already recorded'", async () => {
    await store.recordBet({
      marketId: BTC,
      bettor: "alice",
      outcomeKey: "yes",
      amountMotes: "300000000000",
      dedupeKey: "tx-abc",
    });
    const snapshot = exportSettlementState();
    __resetLedger();
    importSettlementState(snapshot);

    const replay = await store.recordBet({
      marketId: BTC,
      bettor: "alice",
      outcomeKey: "yes",
      amountMotes: "300000000000",
      dedupeKey: "tx-abc",
    });
    expect(replay.poolByOutcomeMotes.yes).toBe("1000000000000");
  });
});

describe("settlement store — settling through the payout engine", () => {
  beforeEach(escrowHouseLiquidity);

  it("pays the winning bettor and is conservation-correct with seed liquidity", async () => {
    // Alice adds 300 CSPR on YES (house already 700 YES / 2300 NO).
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
    const live = await store.get("btc-70k-nov", "testnet");
    expect(live!.status).toBe("resolved");
    expect(live!.resolvedOutcomeKey).toBe("no");
  });
});

describe("settlement store — deadline lock", () => {
  it("locks the market and rejects bets once past the deadline (mirrors the vault)", async () => {
    // Freeze the clock a day after btc-70k-nov's 2026-11-01 deadline.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T00:00:00.000Z"));

    const live = await store.get("btc-70k-nov", "testnet");
    expect(live!.status).toBe("locked");
    await expect(
      store.recordBet({ marketId: BTC, bettor: "late", outcomeKey: "yes", amountMotes: "1" }),
    ).rejects.toThrow(/betting is closed/);
  });

  it("stays open before the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    const live = await store.get("btc-70k-nov", "testnet");
    expect(live!.status).toBe("open");
  });
});
