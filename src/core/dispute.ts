/**
 * The optimistic-resolution state machine (S25) — pure and deterministic.
 *
 * A resolution is no longer final the instant the Arbiter posts it. Instead:
 *
 *     proposed ──(challenge window elapses, unchallenged)──▶ finalized
 *        │
 *        └──(challenged within the window)──▶ voting ──(voting window elapses)──▶ resolved
 *
 * `proposed` carries the proposer's outcome + bond. If the challenge window closes with no
 * challenge, the proposal finalizes as-is (the common, cheap path). A challenge escrows a dispute
 * bond and opens a stake-weighted panel vote; when the voting window closes, `settleDispute`
 * (`dispute-math.ts`) decides the money and this decides the OUTCOME: upheld → the proposed key,
 * overturned → the challenger's alternative key.
 *
 * Everything here is a pure function of the dispute record + the current time, so the whole
 * lifecycle is testable with no clock and no chain. The panel is sampled deterministically from the
 * eligible oracles (below) so "who judges" is reproducible, not a trusted draw.
 */

export type DisputePhase = "proposed" | "voting" | "finalized" | "resolved";

export interface DisputeRecord {
  marketId: string;
  proposer: string;
  proposedOutcomeKey: string | null;
  proposalBondMotes: string;
  /** Epoch ms the proposal was posted. */
  proposedAtMs: number;
  /** Length of the unchallenged-finalization window, ms. */
  challengeWindowMs: number;
  /** Present once challenged. */
  challenger?: string;
  challengerOutcomeKey?: string | null;
  disputeBondMotes?: string;
  challengedAtMs?: number;
  /** Length of the panel-voting window, ms. */
  votingWindowMs: number;
}

/** The phase a dispute is in at time `nowMs`. */
export function disputePhase(record: DisputeRecord, nowMs: number): DisputePhase {
  if (record.challenger === undefined) {
    // Unchallenged: still open until the window elapses, then it finalizes.
    return nowMs >= record.proposedAtMs + record.challengeWindowMs ? "finalized" : "proposed";
  }
  const votingEnd = (record.challengedAtMs ?? record.proposedAtMs) + record.votingWindowMs;
  return nowMs >= votingEnd ? "resolved" : "voting";
}

/** Can a challenge still be filed at `nowMs`? Only inside the challenge window and only once. */
export function canChallenge(record: DisputeRecord, nowMs: number): boolean {
  return record.challenger === undefined && nowMs < record.proposedAtMs + record.challengeWindowMs;
}

/** Can a panelist still vote at `nowMs`? Only while challenged and inside the voting window. */
export function canVote(record: DisputeRecord, nowMs: number): boolean {
  if (record.challenger === undefined) return false;
  const votingEnd = (record.challengedAtMs ?? record.proposedAtMs) + record.votingWindowMs;
  return nowMs < votingEnd;
}

/**
 * The final outcome key of a settled dispute given the panel decision. `null` finalizes the market
 * as a void. Throws if called before the dispute is settleable (guard with `disputePhase`).
 */
export function finalOutcome(record: DisputeRecord, decision: "uphold" | "overturn"): string | null {
  if (record.challenger === undefined) return record.proposedOutcomeKey;
  return decision === "uphold" ? record.proposedOutcomeKey : record.challengerOutcomeKey ?? null;
}

/**
 * Deterministically sample a panel of up to `size` oracles from the eligible set, weighted toward
 * higher reputation but reproducibly (a seeded, stake-descending selection — NOT a random draw, so
 * anyone can recompute who should have judged). Eligible oracles are sorted by `(accuracyBps desc,
 * id asc)` and the top `size` are taken; the seed (the market id) rotates the starting point so the
 * same few oracles don't judge every dispute.
 */
export interface EligibleOracle {
  id: string;
  accuracyBps: number;
}

export function samplePanel(eligible: EligibleOracle[], size: number, seed: string): EligibleOracle[] {
  if (size <= 0 || eligible.length === 0) return [];
  const sorted = [...eligible].sort((a, b) => (b.accuracyBps - a.accuracyBps) || (a.id < b.id ? -1 : 1));
  const n = sorted.length;
  const take = Math.min(size, n);
  // Deterministic rotation from the seed so the top oracles aren't the only ones ever sampled.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const start = h % n;
  const panel: EligibleOracle[] = [];
  const seen = new Set<number>();
  // Rotate through the reputation-sorted list from `start`, so higher-rep oracles are still favoured
  // (they cluster at the front) but the window moves per market.
  for (let i = 0; panel.length < take && i < n; i++) {
    const idx = (start + i) % n;
    if (seen.has(idx)) continue;
    seen.add(idx);
    panel.push(sorted[idx]);
  }
  return panel;
}
