import { describe, it, expect, beforeEach } from "vitest";
import { createContainer } from "@/lib/container";
import { runProphetFleet } from "@/agent/prophet";
import { resolveMarket } from "@/agent/arbiter";
import { runEconomyTick } from "@/agent/economy";
import { computeAgentLeaderboard } from "@/core/agent-leaderboard";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { BREAKER_TRIP_THRESHOLD, recordPaidNotPlaced, resetBreaker } from "@/agent/bet-breaker";

beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetConsumedNonces();
  __resetCreatedMarkets();
  resetBreaker();
});

const maxPnl = (board: { realizedPnlMotes: string }[]) =>
  board.reduce((m, a) => (BigInt(a.realizedPnlMotes) > m ? BigInt(a.realizedPnlMotes) : m), BigInt(board[0].realizedPnlMotes));

describe("The full economy loop (the recursion runs unattended)", () => {
  it("Prophets bet → Arbiter resolves → boards populate → meta-markets settle against the boards", async () => {
    const container = createContainer("testnet");

    // Two non-meta markets the Prophets will trade (they don't self-reference the boards).
    const open = (await container.store.list({ network: "testnet", status: "open" })).filter(
      (m) => m.category !== "meta",
    );
    const [m0, m1] = [open[0].slug, open[1].slug];

    // 1. Prophets bet on two markets.
    await runProphetFleet(container, 0); // targets the first open market
    await runProphetFleet(container, 1); // targets the second

    // 2. Arbiter resolves those two markets — the PnL board fills.
    await resolveMarket(container, m0);
    await resolveMarket(container, m1);

    const board = computeAgentLeaderboard(await container.store.settledEntries("testnet"));
    expect(board.length).toBe(4); // all four Prophets have settled activity
    const best = maxPnl(board);

    // 3. The recursion: prophet-race-weekly settles to the board's top Prophet.
    await resolveMarket(container, "prophet-race-weekly");
    const race = await container.store.settlementFor("testnet:prophet-race-weekly");
    expect(race!.winningOutcomeKey).not.toBeNull();
    const winnerPnl = board.find((a) => a.agent === `agent:${race!.winningOutcomeKey}`)!.realizedPnlMotes;
    expect(BigInt(winnerPnl)).toBe(best); // the winner is a top-PnL Prophet

    // 4. momentum-vs-contrarian settles to whichever of the two out-earned the other.
    await resolveMarket(container, "momentum-vs-contrarian-weekly");
    const duel = await container.store.settlementFor("testnet:momentum-vs-contrarian-weekly");
    expect(["momentum", "contrarian"]).toContain(duel!.winningOutcomeKey);
    const momPnl = BigInt(board.find((a) => a.agent === "agent:momentum")!.realizedPnlMotes);
    const conPnl = BigInt(board.find((a) => a.agent === "agent:contrarian")!.realizedPnlMotes);
    const duelWinnerPnl = BigInt(board.find((a) => a.agent === `agent:${duel!.winningOutcomeKey}`)!.realizedPnlMotes);
    expect(duelWinnerPnl).toBe(momPnl > conPnl ? momPnl : conPnl);

    // 5. arbiter-accuracy-95 settles against the Arbiter's LIVE accuracy — the recursive twist. The
    //    reader can miss (a deterministic minority of external reads are inaccurate), so accuracy is
    //    two-sided; the meta-market must follow it, YES iff accuracy ≥ 95 at decision time.
    const repAtDecision = await container.oracle.reputationOf("arbiter");
    const expectYes = repAtDecision.accuracyBps / 100 >= 95;
    await resolveMarket(container, "arbiter-accuracy-95");
    const acc = await container.store.settlementFor("testnet:arbiter-accuracy-95");
    expect(acc!.winningOutcomeKey).toBe(expectYes ? "yes" : "no");
  });

  it("runEconomyTick advances the economy and returns both boards", async () => {
    const container = createContainer("testnet");

    // Seed the board with one resolved market first.
    const open = (await container.store.list({ network: "testnet", status: "open" })).filter(
      (m) => m.category !== "meta",
    );
    await runProphetFleet(container, 0);
    await resolveMarket(container, open[0].slug);

    const report = await runEconomyTick(container, { seq: 5 });
    expect(report.seq).toBe(5);
    expect(report.prophetActions.length).toBe(4); // the fleet bet this tick
    expect(Array.isArray(report.arbiterActions)).toBe(true); // nothing matured at real time → may be []
    expect(report.leaderboard.length).toBeGreaterThanOrEqual(1);
    expect(report.oracleBoard.some((o) => o.oracleId === "arbiter")).toBe(true);
  });

  it("closes a meta-market inside a single tick via resolveSlugs", async () => {
    const container = createContainer("testnet");
    const open = (await container.store.list({ network: "testnet", status: "open" })).filter(
      (m) => m.category !== "meta",
    );
    await runProphetFleet(container, 0);
    await resolveMarket(container, open[0].slug); // populate the board

    const report = await runEconomyTick(container, { seq: 9, resolveSlugs: ["prophet-race-weekly"] });
    const closed = report.arbiterActions.find((a) => a.marketId.endsWith(":prophet-race-weekly"));
    expect(closed).toBeDefined();
    expect(await container.store.settlementFor("testnet:prophet-race-weekly")).not.toBeNull();
  });
});

/**
 * The breaker's job inside the loop. It outranks affordability: having the money to bet is
 * irrelevant when the last few bets were paid for and never landed. Resolution is deliberately
 * NOT gated by it — that pays people what they are owed, and withholding it to protect the
 * operator's purse would strand user money.
 */
describe("the paid-but-not-placed breaker inside the tick", () => {
  const trip = () => {
    for (let i = 1; i <= BREAKER_TRIP_THRESHOLD; i++) {
      recordPaidNotPlaced({ agentId: "agent:value", deployHash: "ab".repeat(32), reason: "boom", ts: i });
    }
  };

  it("stops the fleet betting once tripped", async () => {
    const container = createContainer("testnet");
    const before = await runEconomyTick(container, { seq: 1 });
    expect(before.prophetActions.length).toBeGreaterThan(0);

    trip();
    const after = await runEconomyTick(container, { seq: 2 });
    expect(after.prophetActions).toEqual([]);
    expect(after.breaker.trippedAt).not.toBeNull();
  });

  it("still resolves matured markets while betting is halted", async () => {
    const container = createContainer("testnet");
    trip();
    // The sweep must still run: a tripped breaker is about the fleet's money, not the users'.
    const report = await runEconomyTick(container, { seq: 3 });
    expect(report.prophetActions).toEqual([]);
    expect(Array.isArray(report.arbiterActions)).toBe(true);
  });

  it("bets again after an operator reset", async () => {
    const container = createContainer("testnet");
    trip();
    expect((await runEconomyTick(container, { seq: 4 })).prophetActions).toEqual([]);
    resetBreaker();
    expect((await runEconomyTick(container, { seq: 5 })).prophetActions.length).toBeGreaterThan(0);
  });
});
