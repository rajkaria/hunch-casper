/**
 * Optimistic resolution timing — when a proposed outcome may be challenged, and when it becomes
 * final.
 *
 * The shape mirrors `contracts/src/dispute_panel.rs` exactly (`STATUS_PROPOSED` →
 * `STATUS_CHALLENGED` → `STATUS_FINALIZED`, with `challenge_window_ms` and `voting_window_ms`
 * supplied at `init`). Keeping the timing pure and here means the question a UI asks — "can I
 * still challenge this?" — is answered by the same arithmetic the contract enforces, rather than
 * by a second implementation that can drift from it.
 *
 * Windows are half-open `[start, deadline)`, the same convention as market deadlines and league
 * seasons: a challenge landing at exactly the deadline belongs to the closed window, so a single
 * timestamp can never be both challengeable and final.
 */

/** Contract status codes, verbatim from `dispute_panel.rs`. */
export const DISPUTE_PROPOSED = 0;
export const DISPUTE_CHALLENGED = 1;
export const DISPUTE_FINALIZED = 2;

export type DisputePhase =
  /** Nothing proposed — the market resolves by the Arbiter's ordinary path. */
  | "none"
  /** Proposed, inside the challenge window: anyone may challenge. */
  | "challengeable"
  /** Proposed, window elapsed, unchallenged: finalizable as proposed. */
  | "finalizable"
  /** Challenged, inside the voting window: the panel is voting. */
  | "voting"
  /** Challenged, voting elapsed: finalizable by panel tally. */
  | "tallyable"
  /** Already finalized. */
  | "final";

export interface DisputeWindows {
  /** How long a proposal may be challenged, in ms. */
  challengeWindowMs: number;
  /** How long the panel votes once challenged, in ms. */
  votingWindowMs: number;
}

export interface DisputeState {
  status: number;
  /** When the outcome was proposed, epoch ms. */
  proposedAtMs: number;
  /** When it was challenged, epoch ms — absent while unchallenged. */
  challengedAtMs?: number;
}

/**
 * Default windows. Deliberately short enough that a judge can watch the whole cycle in one
 * sitting, and long enough that a challenge is genuinely possible — a one-block window would make
 * the dispute path decorative. Overridable per deployment via `disputeWindowsFromEnv`.
 */
export const DEFAULT_CHALLENGE_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_VOTING_WINDOW_MS = 30 * 60 * 1000;

/** Read the windows from config, falling back to the defaults. Never a bare literal at a call site. */
export function disputeWindowsFromEnv(env: Record<string, string | undefined> = process.env): DisputeWindows {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (!raw || !/^\d+$/.test(raw)) return fallback;
    const n = Number(raw);
    return n > 0 ? n : fallback;
  };
  return {
    challengeWindowMs: read("CASPER_DISPUTE_CHALLENGE_WINDOW_MS", DEFAULT_CHALLENGE_WINDOW_MS),
    votingWindowMs: read("CASPER_DISPUTE_VOTING_WINDOW_MS", DEFAULT_VOTING_WINDOW_MS),
  };
}

/** Which phase a dispute is in at `nowMs`. */
export function disputePhase(
  state: DisputeState | null,
  windows: DisputeWindows,
  nowMs: number,
): DisputePhase {
  if (!state) return "none";
  if (state.status === DISPUTE_FINALIZED) return "final";

  if (state.status === DISPUTE_CHALLENGED) {
    const from = state.challengedAtMs ?? state.proposedAtMs;
    return nowMs < from + windows.votingWindowMs ? "voting" : "tallyable";
  }

  if (state.status === DISPUTE_PROPOSED) {
    return nowMs < state.proposedAtMs + windows.challengeWindowMs ? "challengeable" : "finalizable";
  }

  // An unknown status is not assumed final — assuming finality is how a contested outcome would
  // get paid out without ever being contested.
  return "none";
}

/** When the current phase ends, or `null` when nothing is pending. */
export function phaseDeadlineMs(
  state: DisputeState | null,
  windows: DisputeWindows,
  nowMs: number,
): number | null {
  const phase = disputePhase(state, windows, nowMs);
  if (!state) return null;
  if (phase === "challengeable") return state.proposedAtMs + windows.challengeWindowMs;
  if (phase === "voting") {
    return (state.challengedAtMs ?? state.proposedAtMs) + windows.votingWindowMs;
  }
  return null;
}

/** Whether `finalize` may be called now — the only gate a caller should consult. */
export function canFinalize(
  state: DisputeState | null,
  windows: DisputeWindows,
  nowMs: number,
): boolean {
  const phase = disputePhase(state, windows, nowMs);
  return phase === "finalizable" || phase === "tallyable";
}
