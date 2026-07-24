import { describe, expect, it, vi } from "vitest";
import {
  needsChallengeWindow,
  disputeStakeFloorMotes,
  disputeStatus,
  DEFAULT_DISPUTE_STAKE_FLOOR_MOTES,
} from "@/agent/dispute-flow";
import { DISPUTE_PROPOSED, DISPUTE_FINALIZED } from "@/core/dispute-window";
import { createMockClock } from "@/adapters/mock/mock-clock";

const CSPR = 1_000_000_000n;
const T0 = 1_000_000;

function container(nowMs = T0) {
  return { clock: createMockClock(nowMs) } as never;
}

describe("which markets take the optimistic path", () => {
  it("a large pool earns a challenge window", () => {
    expect(needsChallengeWindow({ totalStakedMotes: (500n * CSPR).toString() })).toBe(true);
  });

  it("a small pool on a verifiable source settles immediately", () => {
    expect(
      needsChallengeWindow({ totalStakedMotes: (5n * CSPR).toString(), resolverSource: "drand" }),
    ).toBe(false);
  });

  it("a subjective source is contestable at any size", () => {
    expect(
      needsChallengeWindow({ totalStakedMotes: "0", resolverSource: "cspr_cloud" }),
    ).toBe(true);
  });

  it("drand is never contestable — you cannot argue with public randomness", () => {
    // A challenge could only ever be wrong, so it would burn a bond to argue with arithmetic.
    expect(
      needsChallengeWindow({ totalStakedMotes: (5n * CSPR).toString(), resolverSource: "drand" }),
    ).toBe(false);
  });

  it("meta-markets never take it — the board math is already recomputable", () => {
    expect(
      needsChallengeWindow({
        totalStakedMotes: (900n * CSPR).toString(),
        resolverSource: "cspr_cloud",
        category: "meta",
      }),
    ).toBe(false);
  });

  it("the floor is config, not a literal", () => {
    expect(disputeStakeFloorMotes({})).toBe(DEFAULT_DISPUTE_STAKE_FLOOR_MOTES);
    expect(disputeStakeFloorMotes({ CASPER_DISPUTE_STAKE_FLOOR_MOTES: "5" })).toBe("5");
    expect(disputeStakeFloorMotes({ CASPER_DISPUTE_STAKE_FLOOR_MOTES: "0" })).toBe(
      DEFAULT_DISPUTE_STAKE_FLOOR_MOTES,
    );
    expect(needsChallengeWindow({ totalStakedMotes: "10" }, "5")).toBe(true);
  });

  it("treats a missing stake as zero rather than crashing", () => {
    expect(() => needsChallengeWindow({ totalStakedMotes: undefined as never })).not.toThrow();
  });
});

describe("disputeStatus", () => {
  it("reports no dispute when none exists", async () => {
    const s = await disputeStatus(container(), "m", async () => null);
    expect(s.phase).toBe("none");
    expect(s.finalizable).toBe(false);
    expect(s.deadlineMs).toBeNull();
  });

  it("reports a live challenge window with its deadline", async () => {
    const s = await disputeStatus(container(T0), "m", async () => ({
      status: DISPUTE_PROPOSED,
      proposedAtMs: T0,
    }));
    expect(s.phase).toBe("challengeable");
    expect(s.finalizable).toBe(false);
    expect(s.deadlineMs).toBe(T0 + s.windows.challengeWindowMs);
  });

  it("becomes finalizable once the window elapses", async () => {
    const s = await disputeStatus(container(T0 + 10_000_000), "m", async () => ({
      status: DISPUTE_PROPOSED,
      proposedAtMs: T0,
    }));
    expect(s.phase).toBe("finalizable");
    expect(s.finalizable).toBe(true);
  });

  it("an unreadable dispute is never finalizable", async () => {
    // A read failure must not be mistaken for "no dispute, go ahead and pay out".
    const s = await disputeStatus(container(), "m", async () => {
      throw new Error("rpc down");
    });
    expect(s.phase).toBe("none");
    expect(s.finalizable).toBe(false);
  });

  it("a read failure never throws out to the caller's sweep", async () => {
    const reader = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(disputeStatus(container(), "m", reader)).resolves.toBeDefined();
  });

  it("a finalized dispute is never re-finalizable", async () => {
    const s = await disputeStatus(container(T0 + 10_000_000), "m", async () => ({
      status: DISPUTE_FINALIZED,
      proposedAtMs: T0,
    }));
    expect(s.finalizable).toBe(false);
  });
});
