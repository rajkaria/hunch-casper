import { describe, expect, it, beforeEach } from "vitest";
import {
  appendAction,
  listActions,
  nextRoundSeq,
  __resetActivity,
  ACTIVITY_CAP,
} from "@/adapters/mock/activity-log";

function append(n: number): void {
  for (let i = 0; i < n; i++) {
    appendAction({
      agent: "Momentum",
      kind: "bet_placed",
      marketId: "testnet:x",
      marketTitle: "x",
      narration: "n",
      simulated: true,
    });
  }
}

describe("round seq", () => {
  beforeEach(() => __resetActivity());

  it("keeps advancing after the ring buffer saturates", () => {
    append(ACTIVITY_CAP + 20);
    const first = nextRoundSeq();
    append(5);
    expect(nextRoundSeq()).toBe(first + 5);
  });

  it("does not saturate the way listActions().length does", () => {
    append(120);
    // The defect: the capped, limit-defaulted list length pins the round forever.
    expect(listActions().length).toBe(50);
    expect(nextRoundSeq()).toBeGreaterThanOrEqual(120);
  });

  it("rotates a 4-agent fleet across consecutive rounds", () => {
    append(120);
    const picks = new Set<number>();
    for (let i = 0; i < 4; i++) {
      picks.add(nextRoundSeq() % 4);
      append(1);
    }
    expect(picks.size).toBe(4);
  });
});
