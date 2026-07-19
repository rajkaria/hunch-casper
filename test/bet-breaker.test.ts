/**
 * The paid-but-not-placed breaker.
 *
 * Written against a real incident: the escrow path broke, and every tick for hours paid an agent's
 * stake to the treasury and recorded no bet. Each individual loss was small and bounded; repeated
 * on a 10-minute cron it was neither. These tests pin the property that matters — a repeated
 * paid-for-nothing bet stops the fleet, and only evidence that the money path works starts it again.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  BREAKER_TRIP_THRESHOLD,
  bettingHalted,
  breakerSnapshot,
  exportBreakerState,
  importBreakerState,
  recordPaidNotPlaced,
  recordPlacement,
  resetBreaker,
} from "@/agent/bet-breaker";

const failure = (n: number) => ({
  agentId: "agent:value",
  deployHash: String(n).repeat(64).slice(0, 64),
  reason: "chain submission failed",
  ts: 1_700_000_000_000 + n,
});

beforeEach(() => {
  resetBreaker();
});

describe("bet breaker", () => {
  it("starts closed — a fresh deployment bets", () => {
    expect(bettingHalted()).toBe(false);
    expect(breakerSnapshot().consecutiveFailures).toBe(0);
  });

  it("tolerates failures below the threshold: one bad bet is not an outage", () => {
    for (let i = 1; i < BREAKER_TRIP_THRESHOLD; i++) recordPaidNotPlaced(failure(i));
    expect(bettingHalted()).toBe(false);
    expect(breakerSnapshot().consecutiveFailures).toBe(BREAKER_TRIP_THRESHOLD - 1);
  });

  it("trips on the threshold-th consecutive failure and halts betting", () => {
    for (let i = 1; i <= BREAKER_TRIP_THRESHOLD; i++) recordPaidNotPlaced(failure(i));
    expect(bettingHalted()).toBe(true);
    expect(breakerSnapshot().trippedAt).toBe(failure(BREAKER_TRIP_THRESHOLD).ts);
  });

  it("keeps the FIRST trip time as more failures arrive — when it broke, not when it was last seen", () => {
    for (let i = 1; i <= BREAKER_TRIP_THRESHOLD; i++) recordPaidNotPlaced(failure(i));
    const trippedAt = breakerSnapshot().trippedAt;
    recordPaidNotPlaced(failure(99));
    expect(breakerSnapshot().trippedAt).toBe(trippedAt);
  });

  it("keeps the last failure's settlement hash, so the loss can be reconciled on chain", () => {
    recordPaidNotPlaced(failure(7));
    expect(breakerSnapshot().lastFailure).toMatchObject({
      agentId: "agent:value",
      deployHash: failure(7).deployHash,
      reason: "chain submission failed",
    });
  });

  it("a bet that lands clears the count — the failures it guards against are CONSECUTIVE", () => {
    recordPaidNotPlaced(failure(1));
    recordPaidNotPlaced(failure(2));
    recordPlacement();
    expect(breakerSnapshot().consecutiveFailures).toBe(0);
    // ...so the next failure starts a fresh run rather than inheriting the old one.
    recordPaidNotPlaced(failure(3));
    expect(bettingHalted()).toBe(false);
  });

  it("stays tripped until an operator resets it — no self-healing timeout", () => {
    for (let i = 1; i <= BREAKER_TRIP_THRESHOLD; i++) recordPaidNotPlaced(failure(i));
    expect(bettingHalted()).toBe(true);
    resetBreaker();
    expect(bettingHalted()).toBe(false);
    expect(breakerSnapshot().lastFailure).toBeNull();
  });

  it("survives a cold start through the KV envelope — otherwise it could never reach a threshold", () => {
    // The whole point: serverless instances are short-lived. A counter that resets on every cold
    // start would sit at 1 forever while the money drained.
    for (let i = 1; i <= BREAKER_TRIP_THRESHOLD; i++) recordPaidNotPlaced(failure(i));
    const persisted = JSON.parse(JSON.stringify(exportBreakerState()));
    resetBreaker(); // simulate a fresh instance
    expect(bettingHalted()).toBe(false);
    importBreakerState(persisted);
    expect(bettingHalted()).toBe(true);
    expect(breakerSnapshot().consecutiveFailures).toBe(BREAKER_TRIP_THRESHOLD);
  });

  it("ignores a malformed persisted snapshot rather than crashing the tick", () => {
    importBreakerState({ consecutiveFailures: NaN, lastFailure: null, trippedAt: undefined as never });
    expect(breakerSnapshot().consecutiveFailures).toBe(0);
    expect(bettingHalted()).toBe(false);
  });
});
