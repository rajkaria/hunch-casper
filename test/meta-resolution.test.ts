import { describe, it, expect } from "vitest";
import { resolveMetaMarket } from "@/core/meta-resolution";
import type { EconomyBoards } from "@/core/meta-resolution";
import type { AgentPnl } from "@/core/agent-leaderboard";
import type { ResolverBinding } from "@/core/types";

/** Minimal ranked board entry (only the fields the resolver reads). */
function pnl(agent: string, realizedPnlMotes: string): AgentPnl {
  return {
    agent,
    name: agent.slice("agent:".length),
    stakedMotes: "0",
    returnedMotes: "0",
    realizedPnlMotes,
    roiBps: 0,
    settledCount: 1,
    wins: 0,
  };
}

const PROPHET_RACE: ResolverBinding = {
  kind: "nway_winner",
  source: "internal",
  metric: "prophet_pnl",
  description: "top PnL",
};

const ARBITER_ACCURACY: ResolverBinding = {
  kind: "threshold",
  source: "internal",
  metric: "arbiter_accuracy_pct",
  target: "95",
  comparator: "gte",
  description: "accuracy ≥ 95",
};

describe("resolveMetaMarket — prophet_pnl", () => {
  const outcomes = ["momentum", "contrarian", "value", "chaos"];

  it("picks the top-ranked candidate on the board", () => {
    const boards: EconomyBoards = {
      // board is pre-sorted best-first
      agentPnl: [pnl("agent:value", "9"), pnl("agent:momentum", "4"), pnl("agent:chaos", "-1")],
      arbiterAccuracyPct: 96,
    };
    expect(resolveMetaMarket(PROPHET_RACE, outcomes, boards)).toBe("value");
  });

  it("respects the board's ranking even for a two-way (momentum vs contrarian) duel", () => {
    const boards: EconomyBoards = {
      agentPnl: [pnl("agent:chaos", "20"), pnl("agent:contrarian", "5"), pnl("agent:momentum", "1")],
      arbiterAccuracyPct: 96,
    };
    // chaos tops the board but is not a candidate; contrarian is the top candidate.
    expect(resolveMetaMarket(PROPHET_RACE, ["momentum", "contrarian"], boards)).toBe("contrarian");
  });

  it("voids (null) when no candidate has any settled activity", () => {
    const boards: EconomyBoards = { agentPnl: [pnl("agent:someoneelse", "5")], arbiterAccuracyPct: 96 };
    expect(resolveMetaMarket(PROPHET_RACE, outcomes, boards)).toBeNull();
  });
});

describe("resolveMetaMarket — arbiter_accuracy_pct", () => {
  const outcomes = ["yes", "no"];

  it("YES when accuracy clears the target", () => {
    expect(resolveMetaMarket(ARBITER_ACCURACY, outcomes, { agentPnl: [], arbiterAccuracyPct: 96.09 })).toBe("yes");
  });

  it("NO when accuracy is below the target", () => {
    expect(resolveMetaMarket(ARBITER_ACCURACY, outcomes, { agentPnl: [], arbiterAccuracyPct: 94.0 })).toBe("no");
  });

  it("exactly at the target counts as meeting gte", () => {
    expect(resolveMetaMarket(ARBITER_ACCURACY, outcomes, { agentPnl: [], arbiterAccuracyPct: 95 })).toBe("yes");
  });

  it("honors an lte comparator", () => {
    const lte: ResolverBinding = { ...ARBITER_ACCURACY, comparator: "lte" };
    expect(resolveMetaMarket(lte, outcomes, { agentPnl: [], arbiterAccuracyPct: 94 })).toBe("yes");
    expect(resolveMetaMarket(lte, outcomes, { agentPnl: [], arbiterAccuracyPct: 96 })).toBe("no");
  });
});

describe("resolveMetaMarket — guards", () => {
  it("returns undefined for a non-internal resolver (fall back to the external oracle)", () => {
    const external: ResolverBinding = {
      kind: "threshold",
      source: "coingecko",
      metric: "cspr_usd",
      target: "0.05",
      comparator: "gte",
      description: "price",
    };
    expect(resolveMetaMarket(external, ["yes", "no"], { agentPnl: [], arbiterAccuracyPct: 96 })).toBeUndefined();
  });

  it("voids an unknown internal metric rather than guessing", () => {
    const unknown: ResolverBinding = { kind: "nway_winner", source: "internal", metric: "mystery", description: "?" };
    expect(resolveMetaMarket(unknown, ["a", "b"], { agentPnl: [], arbiterAccuracyPct: 96 })).toBeNull();
  });
});
