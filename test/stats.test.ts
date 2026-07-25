import { describe, expect, it } from "vitest";
import { computeStats, formatCspr } from "@/core/stats";
import type { ChainEvent } from "@/ports/events";

function bet(marketId: string, bettor: string, motes: string, blockHeight = 1): ChainEvent {
  return {
    kind: "bet_placed",
    marketId,
    blockHeight,
    eventIndex: 0,
    deployHash: `${marketId}-${bettor}-${blockHeight}`,
    timestampMs: 0,
    bettor,
    amountMotes: motes,
    outcomeKey: "yes",
  };
}

describe("computeStats", () => {
  it("an empty fold is honestly zero, not absent", () => {
    const s = computeStats([]);
    expect(s.bets).toBe(0);
    expect(s.stakedMotes).toBe("0");
    expect(s.eventCount).toBe(0);
  });

  it("counts bets, stake and distinct bettors", () => {
    const s = computeStats([
      bet("m1", "alice", "1000000000"),
      bet("m1", "bob", "2000000000"),
      bet("m1", "alice", "500000000"),
    ]);
    expect(s.bets).toBe(3);
    expect(s.bettors).toBe(2);
    expect(s.stakedMotes).toBe("3500000000");
  });

  it("collapses a recurring market's rounds onto one market, but counts the rounds", () => {
    // A daily market running for a week is ONE market and SEVEN rounds. Reporting seven markets
    // would inflate the catalogue; reporting one round would hide the activity.
    const s = computeStats([
      bet("cspr-hourly-updown#1", "a", "1"),
      bet("cspr-hourly-updown#2", "a", "1"),
      bet("btc-150k-aug", "a", "1"),
    ]);
    expect(s.markets).toBe(2);
    expect(s.rounds).toBe(3);
  });

  it("counts settled rounds and distinct oracles", () => {
    const s = computeStats([
      bet("m1", "a", "1"),
      {
        kind: "market_resolved",
        marketId: "m1",
        blockHeight: 2,
        eventIndex: 0,
        deployHash: "r1",
        timestampMs: 0,
        oracleId: "arbiter",
        outcomeKey: "yes",
      },
    ]);
    expect(s.settled).toBe(1);
    expect(s.oracles).toBe(1);
  });

  it("does not double-count a round resolved twice", () => {
    const resolve = (h: string): ChainEvent => ({
      kind: "market_resolved",
      marketId: "m1",
      blockHeight: 2,
      eventIndex: 0,
      deployHash: h,
      timestampMs: 0,
      oracleId: "arbiter",
      outcomeKey: "yes",
    });
    expect(computeStats([resolve("a"), resolve("b")]).settled).toBe(1);
  });

  it("sums payouts separately from stake", () => {
    const s = computeStats([
      bet("m1", "a", "1000000000"),
      {
        kind: "payout_claimed",
        marketId: "m1",
        blockHeight: 3,
        eventIndex: 0,
        deployHash: "c1",
        timestampMs: 0,
        claimant: "a",
        amountMotes: "1900000000",
      },
    ]);
    expect(s.stakedMotes).toBe("1000000000");
    expect(s.paidOutMotes).toBe("1900000000");
  });

  it("counts a claim even when the source carries no payout amount", () => {
    // A CSPR.cloud deploy row records the `claim` call, not the transfer the vault makes inside it,
    // so the count is provable from deploy history and the total is not. The count must not be
    // silently lost with the amount, or a settled round looks like nobody was ever paid.
    const s = computeStats([
      {
        kind: "payout_claimed",
        marketId: "m1",
        blockHeight: 4,
        eventIndex: 0,
        deployHash: "c-no-amount",
        timestampMs: 0,
        claimant: "alice",
      },
    ]);
    expect(s.claims).toBe(1);
    expect(s.paidOutMotes).toBe("0");
    expect(computeStats([]).claims).toBe(0);
  });

  it("reports the highest block as the as-of", () => {
    expect(computeStats([bet("m", "a", "1", 5), bet("m", "a", "1", 9)]).lastBlockHeight).toBe(9);
  });

  it("ignores a malformed amount rather than producing NaN", () => {
    const s = computeStats([bet("m", "a", "not-a-number"), bet("m", "a", "5")]);
    expect(s.stakedMotes).toBe("5");
  });

  it("handles stakes far beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = "9".repeat(30);
    expect(computeStats([bet("m", "a", huge), bet("m", "a", huge)]).stakedMotes).toBe(
      (BigInt(huge) * 2n).toString(),
    );
  });
});

describe("formatCspr", () => {
  it("floors rather than overstating", () => {
    expect(formatCspr("1999999999")).toBe("1");
  });

  it("groups thousands", () => {
    expect(formatCspr("1234000000000")).toBe("1,234");
  });

  it("treats junk as zero", () => {
    expect(formatCspr("abc")).toBe("0");
  });
});
