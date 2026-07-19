import { describe, it, expect } from "vitest";
import {
  disputePhase,
  canChallenge,
  canVote,
  finalOutcome,
  samplePanel,
  type DisputeRecord,
  type EligibleOracle,
} from "@/core/dispute";

function proposed(over: Partial<DisputeRecord> = {}): DisputeRecord {
  return {
    marketId: "testnet:m",
    proposer: "P",
    proposedOutcomeKey: "yes",
    proposalBondMotes: "100",
    proposedAtMs: 1000,
    challengeWindowMs: 500,
    votingWindowMs: 500,
    ...over,
  };
}

describe("dispute phase transitions", () => {
  it("proposed → finalized when the challenge window elapses unchallenged", () => {
    const r = proposed();
    expect(disputePhase(r, 1000)).toBe("proposed");
    expect(disputePhase(r, 1499)).toBe("proposed");
    expect(disputePhase(r, 1500)).toBe("finalized");
  });

  it("challenged → voting → resolved", () => {
    const r = proposed({ challenger: "C", challengerOutcomeKey: "no", disputeBondMotes: "80", challengedAtMs: 1200 });
    expect(disputePhase(r, 1300)).toBe("voting");
    expect(disputePhase(r, 1699)).toBe("voting");
    expect(disputePhase(r, 1700)).toBe("resolved");
  });

  it("gates challenge and vote to their windows", () => {
    const r = proposed();
    expect(canChallenge(r, 1400)).toBe(true);
    expect(canChallenge(r, 1500)).toBe(false);
    const c = proposed({ challenger: "C", challengedAtMs: 1200 });
    expect(canChallenge(c, 1300)).toBe(false); // already challenged
    expect(canVote(c, 1600)).toBe(true);
    expect(canVote(c, 1700)).toBe(false);
    expect(canVote(proposed(), 1200)).toBe(false); // not challenged → no voting
  });
});

describe("finalOutcome", () => {
  it("unchallenged → the proposed key", () => {
    expect(finalOutcome(proposed(), "uphold")).toBe("yes");
  });
  it("challenged: uphold → proposed, overturn → challenger's alternative", () => {
    const r = proposed({ challenger: "C", challengerOutcomeKey: "no" });
    expect(finalOutcome(r, "uphold")).toBe("yes");
    expect(finalOutcome(r, "overturn")).toBe("no");
  });
});

describe("samplePanel — deterministic, reputation-favoured", () => {
  const oracles: EligibleOracle[] = [
    { id: "a", accuracyBps: 9000 },
    { id: "b", accuracyBps: 9500 },
    { id: "c", accuracyBps: 8000 },
    { id: "d", accuracyBps: 9500 },
    { id: "e", accuracyBps: 7000 },
  ];

  it("is deterministic for the same seed", () => {
    const p1 = samplePanel(oracles, 3, "testnet:m").map((o) => o.id);
    const p2 = samplePanel(oracles, 3, "testnet:m").map((o) => o.id);
    expect(p1).toEqual(p2);
    expect(p1.length).toBe(3);
  });

  it("varies who judges by seed but stays within the eligible set", () => {
    const a = samplePanel(oracles, 3, "market-A").map((o) => o.id);
    const b = samplePanel(oracles, 3, "market-B").map((o) => o.id);
    for (const id of [...a, ...b]) expect(oracles.some((o) => o.id === id)).toBe(true);
    // No duplicates within a panel.
    expect(new Set(a).size).toBe(a.length);
  });

  it("handles panels larger than the eligible set and empty inputs", () => {
    expect(samplePanel(oracles, 99, "s").length).toBe(oracles.length);
    expect(samplePanel([], 3, "s")).toEqual([]);
    expect(samplePanel(oracles, 0, "s")).toEqual([]);
  });
});
