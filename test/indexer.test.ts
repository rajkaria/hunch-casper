/**
 * The chain-event indexer.
 *
 * The claim this suite has to earn: a board folded from events equals the board folded from
 * in-process ledgers. That equality is the whole point of the sprint — the meta-markets settle
 * against these numbers, so they need to be reproducible by anyone with the chain, not just by
 * this server with its memory intact.
 *
 * The other half is ordering. SSE reconnects and backfills deliver events out of order routinely,
 * and a resolution folded before the bets it settles produces a market with a winner and empty
 * pools — a silently wrong payout, the worst kind.
 */

import { describe, it, expect } from "vitest";
import { indexEvents, settledEntriesFrom, oracleActivityFrom, manifestFor, compareEvents } from "@/core/indexer";
import { computeAgentLeaderboard } from "@/core/agent-leaderboard";
import { computeMarketPayouts } from "@/core/market-payout";
import { mockEvent, demoEventLog, createMockEvents } from "@/adapters/mock/mock-events";
import type { ChainEvent } from "@/ports/events";

const LOG = demoEventLog();

describe("indexEvents — the happy path", () => {
  it("folds a lifecycle into pools, stakes, and a winner", () => {
    const state = indexEvents(LOG);
    const market = state.markets["coin-flip-5m"];
    expect(market.status).toBe("resolved");
    expect(market.winningOutcomeKey).toBe("heads");
    expect(market.poolByOutcomeMotes).toEqual({ heads: "3000000000", tails: "2000000000" });
    expect(market.stakesByBettor["agent:momentum"]).toEqual({ heads: "3000000000" });
    expect(state.lastBlockHeight).toBe(110);
    expect(state.skipped).toEqual([]);
  });

  it("sums repeated bets from the same bettor on the same outcome", () => {
    const state = indexEvents([
      ...LOG.slice(0, 2),
      mockEvent({
        kind: "bet_placed",
        marketId: "coin-flip-5m",
        blockHeight: 102,
        bettor: "agent:momentum",
        outcomeKey: "heads",
        amountMotes: "1000000000",
      }),
    ]);
    expect(state.markets["coin-flip-5m"].stakesByBettor["agent:momentum"].heads).toBe("4000000000");
  });

  it("computes the settlement manifest with the same engine the contract pays from", () => {
    const state = indexEvents(LOG);
    const market = state.markets["coin-flip-5m"];
    expect(manifestFor(market)).toEqual(
      computeMarketPayouts({
        outcomeKeys: market.outcomeKeys,
        poolByOutcomeMotes: market.poolByOutcomeMotes,
        stakesByBettor: market.stakesByBettor,
        feeBps: market.feeBps,
        winningOutcomeKey: "heads",
      }),
    );
  });

  it("leaves an open market without a manifest", () => {
    const state = indexEvents(LOG.slice(0, 3));
    expect(manifestFor(state.markets["coin-flip-5m"])).toBeNull();
    expect(settledEntriesFrom(state)).toEqual([]);
  });
});

describe("indexEvents — ordering", () => {
  it("is invariant to arrival order: shuffled events fold to the same state", () => {
    const inOrder = indexEvents(LOG);
    const shuffled = indexEvents([LOG[3], LOG[1], LOG[0], LOG[2]]);
    expect(shuffled.markets).toEqual(inOrder.markets);
  });

  it("does not let a reordered resolution settle a market before its bets land", () => {
    // The failure this prevents: resolution folded first → winner recorded, pools empty, and every
    // payout computed from that state is wrong while looking perfectly well-formed.
    const state = indexEvents([LOG[3], LOG[0], LOG[1], LOG[2]]);
    const market = state.markets["coin-flip-5m"];
    expect(market.poolByOutcomeMotes).toEqual({ heads: "3000000000", tails: "2000000000" });
    expect(market.status).toBe("resolved");
    expect(state.skipped).toEqual([]);
  });

  it("orders by (blockHeight, eventIndex), then stably by hash", () => {
    const a = mockEvent({ kind: "bet_placed", marketId: "m", blockHeight: 1, eventIndex: 0, deployHash: "aa" });
    const b = mockEvent({ kind: "bet_placed", marketId: "m", blockHeight: 1, eventIndex: 1, deployHash: "bb" });
    const c = mockEvent({ kind: "bet_placed", marketId: "m", blockHeight: 2, eventIndex: 0, deployHash: "cc" });
    expect([c, b, a].sort(compareEvents).map((e) => e.deployHash)).toEqual(["aa", "bb", "cc"]);
    // Same height and index: the hash breaks the tie, so the order is total and reproducible
    // rather than dependent on the sort's stability.
    const tie = mockEvent({ kind: "bet_placed", marketId: "m", blockHeight: 1, eventIndex: 0, deployHash: "ab" });
    expect(compareEvents(a, tie)).toBeLessThan(0);
    expect(compareEvents(tie, a)).toBeGreaterThan(0);
    expect(compareEvents(a, a)).toBe(0);
  });
});

describe("indexEvents — malformed input is skipped loudly, never dropped or thrown", () => {
  function reasons(events: ChainEvent[]): string[] {
    return indexEvents(events).skipped.map((s) => s.reason);
  }

  it("skips an event for a market it never saw created", () => {
    // A stream that started mid-history would otherwise invent a market with no fee and no
    // outcome list, making every payout computed from it wrong.
    expect(reasons([LOG[1]])[0]).toContain("no market_created");
  });

  it("skips a creation without at least two outcomes", () => {
    expect(reasons([mockEvent({ kind: "market_created", marketId: "m", outcomeKeys: ["only"] })])[0]).toContain(
      "two outcome keys",
    );
  });

  it("skips a bet on an outcome the market does not have", () => {
    expect(
      reasons([
        LOG[0],
        mockEvent({
          kind: "bet_placed",
          marketId: "coin-flip-5m",
          blockHeight: 101,
          bettor: "x",
          outcomeKey: "edge",
          amountMotes: "1",
        }),
      ])[0],
    ).toContain("not an outcome");
  });

  it("skips a bet with a malformed amount", () => {
    expect(
      reasons([
        LOG[0],
        mockEvent({
          kind: "bet_placed",
          marketId: "coin-flip-5m",
          blockHeight: 101,
          bettor: "x",
          outcomeKey: "heads",
          amountMotes: "1.5",
        }),
      ])[0],
    ).toContain("valid motes");
  });

  it("skips a resolution to an outcome the market does not have", () => {
    expect(
      reasons([
        ...LOG.slice(0, 3),
        mockEvent({ kind: "market_resolved", marketId: "coin-flip-5m", blockHeight: 110, outcomeKey: "edge" }),
      ])[0],
    ).toContain("not an outcome");
  });

  it("keeps folding the rest of the stream after a skip", () => {
    const state = indexEvents([
      mockEvent({ kind: "bet_placed", marketId: "ghost", blockHeight: 1, bettor: "x", outcomeKey: "y", amountMotes: "1" }),
      ...LOG,
    ]);
    expect(state.skipped).toHaveLength(1);
    expect(state.markets["coin-flip-5m"].status).toBe("resolved");
  });
});

describe("indexEvents — idempotence", () => {
  it("ignores a replayed creation, keeping the one the bets were folded against", () => {
    const state = indexEvents([...LOG, LOG[0]]);
    expect(state.markets["coin-flip-5m"].poolByOutcomeMotes.heads).toBe("3000000000");
  });

  it("keeps the first resolution and ignores a contradicting replay", () => {
    const state = indexEvents([
      ...LOG,
      mockEvent({ kind: "market_resolved", marketId: "coin-flip-5m", blockHeight: 120, outcomeKey: "tails" }),
    ]);
    expect(state.markets["coin-flip-5m"].winningOutcomeKey).toBe("heads");
  });

  it("rejects a bet that arrives after resolution", () => {
    const late = indexEvents([
      ...LOG,
      mockEvent({
        kind: "bet_placed",
        marketId: "coin-flip-5m",
        blockHeight: 111,
        bettor: "agent:latecomer",
        outcomeKey: "heads",
        amountMotes: "9000000000",
      }),
    ]);
    expect(late.skipped[0].reason).toContain("after the market resolved");
    expect(late.markets["coin-flip-5m"].poolByOutcomeMotes.heads).toBe("3000000000");
  });

  it("folds incrementally to the same state as a single pass", () => {
    const incremental = indexEvents(LOG.slice(2), indexEvents(LOG.slice(0, 2)));
    expect(incremental.markets).toEqual(indexEvents(LOG).markets);
  });
});

describe("voided markets", () => {
  const VOIDED = [
    ...LOG.slice(0, 3),
    mockEvent({ kind: "market_resolved", marketId: "coin-flip-5m", blockHeight: 110, voided: true, oracleId: "arbiter" }),
  ];

  it("refunds every stake — a void is PnL-neutral, not a loss", () => {
    const state = indexEvents(VOIDED);
    const manifest = manifestFor(state.markets["coin-flip-5m"])!;
    expect(manifest.mode).toBe("void");
    const board = computeAgentLeaderboard(settledEntriesFrom(state));
    for (const row of board) expect(row.realizedPnlMotes).toBe("0");
  });

  it("does not need a winning outcome to be well-formed", () => {
    expect(indexEvents(VOIDED).skipped).toEqual([]);
    expect(indexEvents(VOIDED).markets["coin-flip-5m"].winningOutcomeKey).toBeNull();
  });
});

describe("the event-derived board equals the money path", () => {
  it("pays winners stake + share of the losing pool, net of fee", () => {
    const state = indexEvents(LOG);
    const board = computeAgentLeaderboard(settledEntriesFrom(state));
    const momentum = board.find((r) => r.agent === "agent:momentum")!;
    const contrarian = board.find((r) => r.agent === "agent:contrarian")!;
    // heads wins: momentum staked 3, contrarian staked 2 and loses it; 2 % fee on the losing pool.
    expect(momentum.stakedMotes).toBe("3000000000");
    expect(BigInt(momentum.realizedPnlMotes)).toBe(1_960_000_000n); // 2 CSPR less the 2 % fee
    expect(contrarian.realizedPnlMotes).toBe("-2000000000");
  });

  it("conserves money: total paid out never exceeds total staked", () => {
    const state = indexEvents(LOG);
    for (const entry of settledEntriesFrom(state)) {
      const staked = Object.values(entry.stakesByBettor)
        .flatMap((byOutcome) => Object.values(byOutcome))
        .reduce((sum, v) => sum + BigInt(v), 0n);
      const paid = Object.values(entry.manifest.payouts).reduce((sum, v) => sum + BigInt(v), 0n);
      expect(paid).toBeLessThanOrEqual(staked);
    }
  });
});

describe("oracleActivityFrom", () => {
  it("counts resolutions per oracle, deterministically", () => {
    expect(oracleActivityFrom(indexEvents(LOG))).toEqual([
      { oracleId: "arbiter", resolved: 1, marketIds: ["coin-flip-5m"] },
    ]);
  });

  it("ignores markets still open", () => {
    expect(oracleActivityFrom(indexEvents(LOG.slice(0, 3)))).toEqual([]);
  });
});

describe("mock EventsPort", () => {
  it("serves the log oldest-first and honours fromBlockHeight", async () => {
    const port = createMockEvents("testnet");
    const all = await port.fetch();
    expect(all.map((e) => e.blockHeight)).toEqual([100, 101, 101, 110]);
    expect(await port.fetch({ fromBlockHeight: 110 })).toHaveLength(1);
    expect(await port.fetch({ limit: 2 })).toHaveLength(2);
  });

  it("delivers events over time on subscribe, and stops on unsubscribe", async () => {
    const port = createMockEvents("testnet", { intervalMs: 1 });
    const received: ChainEvent[] = [];
    const stop = port.subscribe((e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));
    stop();
    const countAtStop = received.length;
    expect(countAtStop).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(received.length).toBe(countAtStop);
  });
});
