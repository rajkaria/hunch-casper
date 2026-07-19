/**
 * Track records and calibration.
 *
 * Two claims have to hold. First, the numbers must agree with the money path to the mote — a
 * reputation score that disagrees with what the vault actually paid is worse than no score.
 * Second, an agent must not be able to improve its own calibration by betting bigger; the forecast
 * it is scored against is the price it *accepted*, read before its own stake lands.
 */

import { describe, it, expect } from "vitest";
import { buildAgentRecords } from "@/core/agent-record";
import {
  BASELINE_BRIER,
  calibrationByCategory,
  calibrationScore,
  impliedProbability,
} from "@/core/calibration";
import { computeMarketPayouts } from "@/core/market-payout";
import { mockEvent } from "@/adapters/mock/mock-events";
import type { ChainEvent } from "@/ports/events";

function market(marketId: string, feeBps = 200): ChainEvent {
  return mockEvent({
    kind: "market_created",
    marketId,
    blockHeight: 100,
    feeBps,
    outcomeKeys: ["yes", "no"],
    oracle: "arbiter",
  });
}

function bet(
  marketId: string,
  bettor: string,
  outcomeKey: string,
  cspr: number,
  blockHeight: number,
  eventIndex = 0,
  timestampMs?: number,
): ChainEvent {
  return mockEvent({
    kind: "bet_placed",
    marketId,
    blockHeight,
    eventIndex,
    bettor,
    outcomeKey,
    amountMotes: `${cspr}000000000`,
    timestampMs,
  });
}

function resolve(marketId: string, outcomeKey: string | null, blockHeight = 200): ChainEvent {
  return mockEvent({
    kind: "market_resolved",
    marketId,
    blockHeight,
    outcomeKey: outcomeKey ?? undefined,
    voided: outcomeKey === null,
    oracleId: "arbiter",
  });
}

describe("impliedProbability", () => {
  it("is the outcome's share of the pool", () => {
    expect(impliedProbability({ yes: "3000000000", no: "1000000000" }, "yes")).toBe(0.75);
  });

  it("reads an empty book as no information, not as certainty", () => {
    expect(impliedProbability({}, "yes")).toBe(0.5);
    expect(impliedProbability({ yes: "0", no: "0" }, "yes")).toBe(0.5);
  });

  it("treats an outcome with no stake as zero probability", () => {
    expect(impliedProbability({ no: "1000000000" }, "yes")).toBe(0);
  });

  it("ignores malformed pool entries rather than producing NaN", () => {
    expect(impliedProbability({ yes: "1000000000", no: "oops" }, "yes")).toBe(1);
  });
});

describe("calibrationScore", () => {
  it("scores a perfect forecaster at zero", () => {
    const score = calibrationScore([
      { forecast: 1, won: true, stakeMotes: "1" },
      { forecast: 0, won: false, stakeMotes: "1" },
    ]);
    expect(score.brier).toBe(0);
    expect(score.skillBps).toBe(10_000);
  });

  it("scores a maximally wrong forecaster at one", () => {
    const score = calibrationScore([{ forecast: 1, won: false, stakeMotes: "1" }]);
    expect(score.brier).toBe(1);
    expect(score.skillBps).toBe(-30_000);
  });

  it("scores the always-50% baseline at 0.25 and zero skill", () => {
    const score = calibrationScore([
      { forecast: 0.5, won: true, stakeMotes: "1" },
      { forecast: 0.5, won: false, stakeMotes: "1" },
    ]);
    expect(score.brier).toBe(BASELINE_BRIER);
    expect(score.skillBps).toBe(0);
  });

  it("weights by stake — a big conviction counts for more than a flutter", () => {
    // Wrong with 100, right with 1: unweighted looks middling, weighted looks bad.
    const score = calibrationScore([
      { forecast: 0.9, won: false, stakeMotes: "100000000000" },
      { forecast: 0.9, won: true, stakeMotes: "1000000000" },
    ]);
    expect(score.weightedBrier).toBeGreaterThan(score.brier);
  });

  it("scores an unproven agent at zero rather than a flattering default", () => {
    // A registry where doing nothing looks perfect rewards doing nothing.
    const score = calibrationScore([]);
    expect(score.sampleCount).toBe(0);
    expect(score.skillBps).toBe(0);
  });

  it("treats an unreadable forecast as no opinion instead of producing NaN", () => {
    const score = calibrationScore([{ forecast: Number.NaN, won: true, stakeMotes: "1" }]);
    expect(score.brier).toBe(0.25);
  });

  it("clamps out-of-range forecasts", () => {
    expect(calibrationScore([{ forecast: 5, won: true, stakeMotes: "1" }]).brier).toBe(0);
    expect(calibrationScore([{ forecast: -5, won: false, stakeMotes: "1" }]).brier).toBe(0);
  });

  it("reports hit rate and mean forecast", () => {
    const score = calibrationScore([
      { forecast: 0.8, won: true, stakeMotes: "1" },
      { forecast: 0.6, won: false, stakeMotes: "1" },
    ]);
    expect(score.hitRate).toBe(0.5);
    expect(score.meanForecast).toBeCloseTo(0.7);
  });
});

describe("calibrationByCategory", () => {
  it("separates expertise by category — one blended number hides it", () => {
    const byCategory = calibrationByCategory([
      { forecast: 1, won: true, stakeMotes: "1", category: "casper-native" },
      { forecast: 1, won: false, stakeMotes: "1", category: "crypto" },
    ]);
    expect(byCategory.map((c) => c.category)).toEqual(["casper-native", "crypto"]);
    expect(byCategory[0].brier).toBe(0);
    expect(byCategory[1].brier).toBe(1);
  });

  it("buckets uncategorised samples rather than dropping them", () => {
    expect(calibrationByCategory([{ forecast: 0.5, won: true, stakeMotes: "1" }])[0].category).toBe(
      "uncategorised",
    );
  });
});

describe("buildAgentRecords", () => {
  const LOG = [
    market("m1"),
    bet("m1", "agent:alpha", "yes", 3, 101),
    bet("m1", "agent:beta", "no", 2, 102),
    resolve("m1", "yes"),
  ];

  it("agrees with the money path to the mote", () => {
    // A reputation score that disagrees with what the vault paid is worse than no score.
    const [alpha] = buildAgentRecords(LOG).filter((r) => r.agent === "agent:alpha");
    const manifest = computeMarketPayouts({
      outcomeKeys: ["yes", "no"],
      poolByOutcomeMotes: { yes: "3000000000", no: "2000000000" },
      stakesByBettor: { "agent:alpha": { yes: "3000000000" }, "agent:beta": { no: "2000000000" } },
      feeBps: 200,
      winningOutcomeKey: "yes",
    });
    expect(alpha.returnedMotes).toBe(manifest.payouts["agent:alpha"]);
    expect(alpha.realizedPnlMotes).toBe(
      (BigInt(manifest.payouts["agent:alpha"]) - 3_000_000_000n).toString(),
    );
  });

  it("counts wins, volume, and markets touched", () => {
    const records = buildAgentRecords(LOG);
    const alpha = records.find((r) => r.agent === "agent:alpha")!;
    expect(alpha.wins).toBe(1);
    expect(alpha.winRate).toBe(1);
    expect(alpha.settledCount).toBe(1);
    expect(alpha.betCount).toBe(1);
    expect(alpha.marketCount).toBe(1);
    expect(alpha.volumeMotes).toBe("3000000000");
    const beta = records.find((r) => r.agent === "agent:beta")!;
    expect(beta.wins).toBe(0);
    expect(beta.realizedPnlMotes).toBe("-2000000000");
  });

  it("scores an agent against the price it ACCEPTED, not the one its stake created", () => {
    // Alpha bets into an empty book: the price it accepted was 0.5, so a win scores 0.25 — not
    // the 1.0 implied probability its own stake produced. Otherwise an agent could inflate its
    // calibration simply by betting bigger.
    const alpha = buildAgentRecords(LOG).find((r) => r.agent === "agent:alpha")!;
    expect(alpha.calibration.brier).toBe(0.25);
  });

  it("scores a later bettor against the book it actually faced", () => {
    // Beta bets "no" when the book is 3 yes / 0 no: implied probability of "no" is 0, it loses,
    // so the forecast was exactly right and the Brier score is 0.
    const beta = buildAgentRecords(LOG).find((r) => r.agent === "agent:beta")!;
    expect(beta.calibration.brier).toBe(0);
  });

  it("does not score a voided market — nobody forecast anything", () => {
    const records = buildAgentRecords([
      market("m1"),
      bet("m1", "agent:alpha", "yes", 3, 101),
      bet("m1", "agent:beta", "no", 2, 102),
      resolve("m1", null),
    ]);
    const alpha = records.find((r) => r.agent === "agent:alpha")!;
    expect(alpha.calibration.sampleCount).toBe(0);
    expect(alpha.realizedPnlMotes).toBe("0"); // a void refunds the stake
    expect(alpha.settledCount).toBe(1);
  });

  it("ignores markets still open when computing PnL, but counts them as volume", () => {
    const records = buildAgentRecords([market("m1"), bet("m1", "agent:alpha", "yes", 3, 101)]);
    const alpha = records.find((r) => r.agent === "agent:alpha")!;
    expect(alpha.settledCount).toBe(0);
    expect(alpha.stakedMotes).toBe("0");
    expect(alpha.volumeMotes).toBe("3000000000");
  });

  it("counts a market once even when an agent bet into it several times", () => {
    const records = buildAgentRecords([
      market("m1"),
      bet("m1", "agent:alpha", "yes", 2, 101, 0),
      bet("m1", "agent:alpha", "yes", 1, 102, 0),
      bet("m1", "agent:beta", "no", 2, 103),
      resolve("m1", "yes"),
    ]);
    const alpha = records.find((r) => r.agent === "agent:alpha")!;
    expect(alpha.settledCount).toBe(1);
    expect(alpha.betCount).toBe(2);
    expect(alpha.stakedMotes).toBe("3000000000");
  });

  it("is invariant to arrival order", () => {
    const shuffled = buildAgentRecords([LOG[3], LOG[1], LOG[0], LOG[2]]);
    expect(shuffled).toEqual(buildAgentRecords(LOG));
  });

  it("ranks skill above luck: better calibration wins even on lower PnL", () => {
    // Sharp bets into a book already pricing "yes" at ~1.0 and is right: a near-perfect forecast
    // for almost no profit. Lucky bets into an empty book (price 0.5, no information) and wins
    // big. PnL ranks Lucky first; calibration ranks Sharp first, and calibration is what a
    // consumer of these numbers actually needs.
    const records = buildAgentRecords([
      market("m1"),
      bet("m1", "agent:filler", "yes", 4, 101),
      bet("m1", "agent:sharp", "yes", 1, 102),
      resolve("m1", "yes"),
      market("m2"),
      bet("m2", "agent:lucky", "yes", 50, 103),
      bet("m2", "agent:filler", "no", 1, 104),
      resolve("m2", "yes", 201),
    ]);
    const sharp = records.findIndex((r) => r.agent === "agent:sharp");
    const lucky = records.findIndex((r) => r.agent === "agent:lucky");
    expect(BigInt(records[lucky].realizedPnlMotes)).toBeGreaterThan(0n);
    expect(sharp).toBeLessThan(lucky);
  });

  it("sorts agents with nothing settled last, not first", () => {
    // An unscored agent has Brier 0, which would otherwise read as perfect.
    const records = buildAgentRecords([
      market("m1"),
      bet("m1", "agent:alpha", "yes", 3, 101),
      bet("m1", "agent:beta", "no", 2, 102),
      resolve("m1", "yes"),
      market("m2"),
      bet("m2", "agent:unproven", "yes", 1, 103),
    ]);
    expect(records[records.length - 1].agent).toBe("agent:unproven");
  });

  it("groups expertise by the catalogue's categories", () => {
    const records = buildAgentRecords(LOG, { m1: { category: "casper-native", feeBps: 200 } });
    expect(records[0].byCategory[0].category).toBe("casper-native");
  });

  it("skips events for a market it never saw created", () => {
    expect(buildAgentRecords([bet("ghost", "agent:alpha", "yes", 1, 101)])).toEqual([]);
  });

  it("records first and last activity, for the age signal", () => {
    const records = buildAgentRecords([
      market("m1"),
      bet("m1", "agent:alpha", "yes", 1, 101, 0, 1_000),
      bet("m1", "agent:alpha", "yes", 1, 102, 0, 9_000),
      bet("m1", "agent:beta", "no", 1, 103),
      resolve("m1", "yes"),
    ]);
    const alpha = records.find((r) => r.agent === "agent:alpha")!;
    expect(alpha.firstBetAt).toBe(1_000);
    expect(alpha.lastBetAt).toBe(9_000);
  });
});
