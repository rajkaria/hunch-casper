import { describe, expect, it } from "vitest";
import {
  DISPUTE_PROPOSED,
  DISPUTE_CHALLENGED,
  DISPUTE_FINALIZED,
  DEFAULT_CHALLENGE_WINDOW_MS,
  DEFAULT_VOTING_WINDOW_MS,
  disputePhase,
  disputeWindowsFromEnv,
  phaseDeadlineMs,
  canFinalize,
} from "@/core/dispute-window";

const W = { challengeWindowMs: 1000, votingWindowMs: 2000 };
const T0 = 1_000_000;

describe("dispute phases", () => {
  it("no dispute means no phase", () => {
    expect(disputePhase(null, W, T0)).toBe("none");
    expect(canFinalize(null, W, T0)).toBe(false);
  });

  it("a fresh proposal is challengeable", () => {
    const s = { status: DISPUTE_PROPOSED, proposedAtMs: T0 };
    expect(disputePhase(s, W, T0)).toBe("challengeable");
    expect(disputePhase(s, W, T0 + 999)).toBe("challengeable");
  });

  it("the window is half-open — at the deadline it is already closed", () => {
    // A single instant must never be both challengeable and final.
    const s = { status: DISPUTE_PROPOSED, proposedAtMs: T0 };
    expect(disputePhase(s, W, T0 + 1000)).toBe("finalizable");
  });

  it("an unchallenged proposal past its window is finalizable", () => {
    const s = { status: DISPUTE_PROPOSED, proposedAtMs: T0 };
    expect(canFinalize(s, W, T0 + 1001)).toBe(true);
  });

  it("a challenge opens the voting window from the CHALLENGE time", () => {
    const s = { status: DISPUTE_CHALLENGED, proposedAtMs: T0, challengedAtMs: T0 + 500 };
    expect(disputePhase(s, W, T0 + 900)).toBe("voting");
    expect(disputePhase(s, W, T0 + 2499)).toBe("voting");
    expect(disputePhase(s, W, T0 + 2500)).toBe("tallyable");
  });

  it("falls back to the proposal time when a challenge carries no timestamp", () => {
    const s = { status: DISPUTE_CHALLENGED, proposedAtMs: T0 };
    expect(disputePhase(s, W, T0 + 1999)).toBe("voting");
    expect(disputePhase(s, W, T0 + 2000)).toBe("tallyable");
  });

  it("a finalized dispute is final and never re-finalizable", () => {
    const s = { status: DISPUTE_FINALIZED, proposedAtMs: T0 };
    expect(disputePhase(s, W, T0 + 999_999)).toBe("final");
    expect(canFinalize(s, W, T0 + 999_999)).toBe(false);
  });

  it("an unknown status is never assumed final", () => {
    // Assuming finality is how a contested outcome gets paid out without being contested.
    const s = { status: 99, proposedAtMs: T0 };
    expect(disputePhase(s, W, T0)).toBe("none");
    expect(canFinalize(s, W, T0)).toBe(false);
  });

  it("reports the deadline of whatever is pending", () => {
    expect(phaseDeadlineMs({ status: DISPUTE_PROPOSED, proposedAtMs: T0 }, W, T0)).toBe(T0 + 1000);
    expect(
      phaseDeadlineMs({ status: DISPUTE_CHALLENGED, proposedAtMs: T0, challengedAtMs: T0 + 500 }, W, T0 + 600),
    ).toBe(T0 + 2500);
    expect(phaseDeadlineMs({ status: DISPUTE_FINALIZED, proposedAtMs: T0 }, W, T0)).toBeNull();
  });
});

describe("windows come from config, never a literal", () => {
  it("defaults when unset", () => {
    expect(disputeWindowsFromEnv({})).toEqual({
      challengeWindowMs: DEFAULT_CHALLENGE_WINDOW_MS,
      votingWindowMs: DEFAULT_VOTING_WINDOW_MS,
    });
  });

  it("honours explicit values", () => {
    expect(
      disputeWindowsFromEnv({
        CASPER_DISPUTE_CHALLENGE_WINDOW_MS: "60000",
        CASPER_DISPUTE_VOTING_WINDOW_MS: "120000",
      }),
    ).toEqual({ challengeWindowMs: 60_000, votingWindowMs: 120_000 });
  });

  it("ignores junk and zero rather than opening a zero-length window", () => {
    // A zero-length challenge window makes the dispute path decorative — the outcome would be
    // final the instant it was proposed.
    const w = disputeWindowsFromEnv({
      CASPER_DISPUTE_CHALLENGE_WINDOW_MS: "0",
      CASPER_DISPUTE_VOTING_WINDOW_MS: "abc",
    });
    expect(w.challengeWindowMs).toBe(DEFAULT_CHALLENGE_WINDOW_MS);
    expect(w.votingWindowMs).toBe(DEFAULT_VOTING_WINDOW_MS);
  });
});
