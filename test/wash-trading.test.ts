/**
 * Wash-trading heuristics.
 *
 * The tests that matter most are the negative ones. Every signal here has an innocent
 * explanation — hedging, bots, early liquidity — and a heuristic that fires on normal behaviour
 * would cost honest agents their bonds while the false positives stayed invisible. So the
 * thresholds are pinned in both directions: what must fire, and what must not.
 */

import { describe, it, expect } from "vitest";
import {
  BURST_WINDOW_MS,
  PAIRED_MIN_OCCURRENCES,
  POOL_DOMINATION_RATIO,
  SELF_CROSS_MIN_RATIO,
  detectWashTrading,
  signalsFor,
} from "@/core/wash-trading";
import { mockEvent } from "@/adapters/mock/mock-events";
import type { ChainEvent } from "@/ports/events";

let height = 100;
function bet(marketId: string, bettor: string, outcomeKey: string, motes: string, timestampMs: number): ChainEvent {
  return mockEvent({
    kind: "bet_placed",
    marketId,
    blockHeight: height++,
    bettor,
    outcomeKey,
    amountMotes: motes,
    timestampMs,
  });
}

const CSPR = "1000000000";
function cspr(n: number): string {
  return (BigInt(n) * BigInt(CSPR)).toString();
}

describe("self-crossing", () => {
  it("flags a balanced two-sided position in one market", () => {
    const signals = detectWashTrading([
      bet("m1", "agent:wash", "yes", cspr(10), 1_000),
      bet("m1", "agent:wash", "no", cspr(10), 2_000),
    ]);
    const flagged = signals.find((s) => s.kind === "self_crossing")!;
    expect(flagged.agents).toEqual(["agent:wash"]);
    expect(flagged.strength).toBeCloseTo(1);
    expect(flagged.detail).toContain("m1");
  });

  it("does NOT flag a small hedge against a large position", () => {
    // 10 % on the other side is risk management, not manufacture.
    const signals = detectWashTrading([
      bet("m1", "agent:hedger", "yes", cspr(90), 1_000),
      bet("m1", "agent:hedger", "no", cspr(10), 2_000),
    ]);
    expect(signals.some((s) => s.kind === "self_crossing")).toBe(false);
  });

  it("scales strength with how balanced the two sides are", () => {
    const balanced = detectWashTrading([
      bet("m1", "a", "yes", cspr(50), 1_000),
      bet("m1", "a", "no", cspr(50), 2_000),
    ]).find((s) => s.kind === "self_crossing")!;
    const lopsided = detectWashTrading([
      bet("m2", "a", "yes", cspr(75), 1_000),
      bet("m2", "a", "no", cspr(25), 2_000),
    ]).find((s) => s.kind === "self_crossing")!;
    expect(balanced.strength).toBeGreaterThan(lopsided.strength);
  });

  it("never fires on a one-sided position", () => {
    expect(
      detectWashTrading([bet("m1", "a", "yes", cspr(10), 1_000), bet("m1", "a", "yes", cspr(10), 2_000)]),
    ).toEqual([]);
  });

  it("exports its threshold so a reader can see what tripped", () => {
    expect(SELF_CROSS_MIN_RATIO).toBe(0.2);
  });
});

describe("pool domination", () => {
  it("flags an agent that holds nearly the whole pool", () => {
    const signals = detectWashTrading([
      bet("m1", "agent:whale", "yes", cspr(95), 1_000),
      bet("m1", "agent:minnow", "no", cspr(5), 2_000),
    ]);
    const flagged = signals.find((s) => s.kind === "pool_domination")!;
    expect(flagged.agents).toEqual(["agent:whale"]);
    expect(flagged.detail).toContain("95%");
  });

  it("does NOT flag ordinary concentration in a thin market", () => {
    const signals = detectWashTrading([
      bet("m1", "agent:a", "yes", cspr(70), 1_000),
      bet("m1", "agent:b", "no", cspr(30), 2_000),
    ]);
    expect(signals.some((s) => s.kind === "pool_domination")).toBe(false);
    expect(POOL_DOMINATION_RATIO).toBe(0.8);
  });
});

describe("paired offsetting", () => {
  function pairedRounds(count: number): ChainEvent[] {
    const events: ChainEvent[] = [];
    for (let i = 0; i < count; i++) {
      events.push(bet(`m${i}`, "agent:a", "yes", cspr(5), i * 100_000));
      events.push(bet(`m${i}`, "agent:b", "no", cspr(5), i * 100_000 + 500));
    }
    return events;
  }

  it("flags a pair that repeatedly takes opposite sides within seconds", () => {
    const signals = detectWashTrading(pairedRounds(PAIRED_MIN_OCCURRENCES));
    const flagged = signals.find((s) => s.kind === "paired_offsetting")!;
    expect(flagged.agents.sort()).toEqual(["agent:a", "agent:b"]);
    expect(flagged.marketIds).toHaveLength(PAIRED_MIN_OCCURRENCES);
  });

  it("does NOT flag a pair below the occurrence floor — twice is coincidence", () => {
    expect(detectWashTrading(pairedRounds(PAIRED_MIN_OCCURRENCES - 1)).some((s) => s.kind === "paired_offsetting")).toBe(
      false,
    );
  });

  it("does NOT flag opposite sides taken far apart in time", () => {
    // Two people reading the same news an hour apart are not a sybil pair.
    const events: ChainEvent[] = [];
    for (let i = 0; i < PAIRED_MIN_OCCURRENCES + 2; i++) {
      events.push(bet(`m${i}`, "agent:a", "yes", cspr(5), i * 100_000));
      events.push(bet(`m${i}`, "agent:b", "no", cspr(5), i * 100_000 + BURST_WINDOW_MS * 10));
    }
    expect(detectWashTrading(events).some((s) => s.kind === "paired_offsetting")).toBe(false);
  });

  it("does NOT flag agents on the SAME side", () => {
    const events: ChainEvent[] = [];
    for (let i = 0; i < PAIRED_MIN_OCCURRENCES + 2; i++) {
      events.push(bet(`m${i}`, "agent:a", "yes", cspr(5), i * 100_000));
      events.push(bet(`m${i}`, "agent:b", "yes", cspr(5), i * 100_000 + 200));
    }
    expect(detectWashTrading(events).some((s) => s.kind === "paired_offsetting")).toBe(false);
  });
});

describe("burst timing", () => {
  it("flags one agent firing into several markets within seconds", () => {
    const events = Array.from({ length: PAIRED_MIN_OCCURRENCES + 1 }, (_, i) =>
      bet(`m${i}`, "agent:bot", "yes", cspr(1), i * 500),
    );
    const flagged = detectWashTrading(events).find((s) => s.kind === "burst_timing")!;
    expect(flagged.agents).toEqual(["agent:bot"]);
  });

  it("does NOT flag an agent pacing itself across markets", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      bet(`m${i}`, "agent:paced", "yes", cspr(1), i * (BURST_WINDOW_MS * 3)),
    );
    expect(detectWashTrading(events).some((s) => s.kind === "burst_timing")).toBe(false);
  });
});

describe("output shape", () => {
  it("is deterministic and strongest-first", () => {
    const events = [
      bet("m1", "agent:wash", "yes", cspr(50), 1_000),
      bet("m1", "agent:wash", "no", cspr(50), 2_000),
      bet("m2", "agent:mild", "yes", cspr(70), 3_000),
      bet("m2", "agent:mild", "no", cspr(30), 4_000),
    ];
    const first = detectWashTrading(events);
    expect(detectWashTrading(events)).toEqual(first);
    for (let i = 1; i < first.length; i++) {
      expect(first[i - 1].strength).toBeGreaterThanOrEqual(first[i].strength);
    }
  });

  it("filters to one agent's signals for a reputation lookup", () => {
    const signals = detectWashTrading([
      bet("m1", "agent:wash", "yes", cspr(50), 1_000),
      bet("m1", "agent:wash", "no", cspr(50), 2_000),
    ]);
    expect(signalsFor(signals, "agent:wash")).toHaveLength(signals.length);
    expect(signalsFor(signals, "agent:innocent")).toEqual([]);
  });

  it("finds nothing in a clean market", () => {
    expect(
      detectWashTrading([
        bet("m1", "agent:a", "yes", cspr(30), 1_000),
        bet("m1", "agent:b", "no", cspr(40), 60_000),
        bet("m1", "agent:c", "yes", cspr(30), 120_000),
      ]),
    ).toEqual([]);
  });

  it("ignores non-bet events and malformed amounts", () => {
    expect(
      detectWashTrading([
        mockEvent({ kind: "market_created", marketId: "m1", outcomeKeys: ["yes", "no"] }),
        mockEvent({ kind: "bet_placed", marketId: "m1", bettor: "a", outcomeKey: "yes", amountMotes: "oops" }),
      ]),
    ).toEqual([]);
  });
});
