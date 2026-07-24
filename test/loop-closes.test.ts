/**
 * The end-to-end guard: does the economy actually complete its cycle?
 *
 * Every unit in this phase can be green while the loop still fails to close — that is exactly the
 * state production was in for 2.7 days, with fourteen health checks passing. This test advances a
 * pinned clock across a round boundary and asserts the whole causal chain: a round opens, takes
 * bets, matures, resolves, and the settled entry reaches the board the meta-markets score against.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runEconomyTick } from "@/agent/economy";
import { createContainer } from "@/lib/container";
import { createMockClock } from "@/adapters/mock/mock-clock";
import { createSystemClock } from "@/adapters/system-clock";
import { setLedgerClock } from "@/adapters/mock/settlement-ledger";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { __resetQuarantine } from "@/agent/market-quarantine";
import { currentRound } from "@/core/round-schedule";
import { roundMarketId } from "@/core/round-id";

const DAY = 86_400_000;
const START = Date.parse("2026-09-15T13:37:00.000Z");

beforeEach(() => {
  __resetCreatedMarkets();
  __resetActivity();
  __resetQuarantine();
});
afterEach(() => {
  setLedgerClock(createSystemClock());
  __resetCreatedMarkets();
  __resetActivity();
  __resetQuarantine();
});

describe("the loop closes", () => {
  it("opens a round, bets it, matures it, resolves it, and lands it on the board", async () => {
    const clock = createMockClock(START);
    setLedgerClock(clock);
    const container = { ...createContainer("testnet"), clock };

    // 1. A tick opens the current round of every recurring market.
    const opened = await runEconomyTick(container, { seq: 1 });
    expect(opened.rolloverActions.length).toBeGreaterThan(0);

    const round = currentRound("daily", START)!;
    const roundSlug = roundMarketId("cspr-hourly-updown", round.index);
    expect(opened.rolloverActions.some((a) => a.marketId.includes(roundSlug))).toBe(true);

    // 2. Bet it across several rounds while it is open.
    for (let seq = 2; seq < 12; seq++) await runEconomyTick(container, { seq });

    // 3. Advance past the round's deadline. Nothing else changes.
    clock.set(round.deadlineMs + 1);

    // 4. The next tick must resolve the matured round — this is the step that never happened.
    const afterMaturity = await runEconomyTick(container, { seq: 12 });
    expect(afterMaturity.arbiterActions.length).toBeGreaterThan(0);

    // 5. ...and the settled result must reach the board the meta-markets score against.
    expect(afterMaturity.leaderboard.length).toBeGreaterThan(0);

    // 6. ...and a fresh round must exist, or the market is a dead surface next tick.
    const nextRound = currentRound("daily", round.deadlineMs + 1)!;
    expect(nextRound.index).toBe(round.index + 1);
    expect(
      afterMaturity.rolloverActions.some((a) =>
        a.marketId.includes(roundMarketId("cspr-hourly-updown", nextRound.index)),
      ),
    ).toBe(true);
  });

  it("keeps closing across several consecutive rounds", async () => {
    const clock = createMockClock(START);
    setLedgerClock(clock);
    const container = { ...createContainer("testnet"), clock };

    let resolutions = 0;
    let seq = 1;
    for (let day = 0; day < 4; day++) {
      await runEconomyTick(container, { seq: seq++ });
      clock.set(START + (day + 1) * DAY);
      resolutions += (await runEconomyTick(container, { seq: seq++ })).arbiterActions.length;
    }
    // Four days must produce more than one settlement, or the loop closes once and stalls.
    expect(resolutions).toBeGreaterThan(1);
  });
});
