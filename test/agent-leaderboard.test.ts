import { describe, it, expect } from "vitest";
import { computeAgentLeaderboard } from "@/core/agent-leaderboard";
import type { SettledStakeEntry } from "@/core/agent-leaderboard";

/** Helper: one settled market's stakes + payouts. */
function entry(
  stakes: Record<string, Record<string, string>>,
  payouts: Record<string, string>,
): SettledStakeEntry {
  return { stakesByBettor: stakes, manifest: { payouts } };
}

describe("computeAgentLeaderboard", () => {
  it("folds one settled market into signed PnL, ROI, wins, and settled count", () => {
    const board = computeAgentLeaderboard([
      entry(
        {
          "agent:momentum": { yes: "3000000000" }, // staked 3 CSPR
          "agent:contrarian": { no: "2000000000" }, // staked 2 CSPR
          "house:liquidity": { yes: "1000000000", no: "1000000000" },
        },
        {
          "agent:momentum": "5000000000", // returned 5 → +2
          "house:liquidity": "2000000000",
          // contrarian lost → no payout
        },
      ),
    ]);

    // House is excluded — the board is exactly the agent swarm.
    expect(board.map((a) => a.agent)).toEqual(["agent:momentum", "agent:contrarian"]);

    const momentum = board[0];
    expect(momentum.name).toBe("Momentum");
    expect(momentum.stakedMotes).toBe("3000000000");
    expect(momentum.returnedMotes).toBe("5000000000");
    expect(momentum.realizedPnlMotes).toBe("2000000000"); // +2 CSPR
    expect(momentum.roiBps).toBe(6666); // floor(2/3 * 10000)
    expect(momentum.wins).toBe(1);
    expect(momentum.settledCount).toBe(1);

    const contrarian = board[1];
    expect(contrarian.realizedPnlMotes).toBe("-2000000000"); // lost full stake
    expect(contrarian.roiBps).toBe(-10000);
    expect(contrarian.wins).toBe(0);
  });

  it("aggregates an agent across multiple settled markets", () => {
    const board = computeAgentLeaderboard([
      entry({ "agent:value": { yes: "2000000000" } }, { "agent:value": "3000000000" }), // +1
      entry({ "agent:value": { no: "2000000000" } }, {}), // -2
    ]);
    const value = board[0];
    expect(value.stakedMotes).toBe("4000000000");
    expect(value.returnedMotes).toBe("3000000000");
    expect(value.realizedPnlMotes).toBe("-1000000000"); // +1 - 2
    expect(value.settledCount).toBe(2);
    expect(value.wins).toBe(1);
  });

  it("ranks by PnL desc, tie-broken by less staked then agent id", () => {
    const board = computeAgentLeaderboard([
      entry(
        {
          "agent:chaos": { yes: "1000000000" }, // +1 on 1 staked
          "agent:contrarian": { yes: "2000000000" }, // +1 on 2 staked
          "agent:value": { yes: "2000000000" }, // +1 on 2 staked
        },
        {
          "agent:chaos": "2000000000",
          "agent:contrarian": "3000000000",
          "agent:value": "3000000000",
        },
      ),
    ]);
    // All +1 PnL: chaos (staked 1) first; then contrarian vs value both staked 2 → id asc.
    expect(board.map((a) => a.agent)).toEqual(["agent:chaos", "agent:contrarian", "agent:value"]);
  });

  it("excludes non-agent bettors (house, human public keys) entirely", () => {
    const board = computeAgentLeaderboard([
      entry(
        { "house:liquidity": { yes: "5000000000" }, "0abc...pubkey": { yes: "1000000000" } },
        { "house:liquidity": "6000000000", "0abc...pubkey": "1200000000" },
      ),
    ]);
    expect(board).toEqual([]);
  });

  it("returns an empty board when nothing has settled", () => {
    expect(computeAgentLeaderboard([])).toEqual([]);
  });

  it("is deterministic — same entries, same board", () => {
    const entries = [entry({ "agent:momentum": { yes: "3000000000" } }, { "agent:momentum": "4000000000" })];
    expect(computeAgentLeaderboard(entries)).toEqual(computeAgentLeaderboard(entries));
  });
});
