/**
 * Optimistic resolution — the Arbiter proposes, anyone may challenge, the panel decides.
 *
 * "A wrong resolution can be challenged" was a deployed capability with no live path: the
 * `DisputePanel` contract shipped and nothing ever called it, so the claim rested on a contract
 * nobody had exercised. This is the seam that makes it real.
 *
 * **Which markets take this path is a policy decision, and a deliberately narrow one.** Every
 * resolution going through a challenge window would delay every payout by that window, for the
 * benefit of the rare contested call. So the default is: markets whose resolver reads a
 * subjective or off-chain source, and any market whose stake exceeds a configured threshold —
 * where being wrong is expensive enough to be worth waiting on. Everything else keeps the
 * immediate path.
 *
 * **An LLM never decides a vote or sizes a payout.** It may draft a rationale. Every number here
 * comes from `core/dispute-math.ts` and the contract, both integer-exact.
 */

import type { Container } from "@/lib/container";
import type { Market } from "@/core/types";
import {
  canFinalize,
  disputePhase,
  disputeWindowsFromEnv,
  type DisputePhase,
  type DisputeState,
  type DisputeWindows,
} from "@/core/dispute-window";

/**
 * Stake above which a resolution is worth a challenge window, in motes. Default 100 CSPR — high
 * enough that the ordinary catalogue settles immediately, low enough that a genuinely large pool
 * gets the protection.
 */
export const DEFAULT_DISPUTE_STAKE_FLOOR_MOTES = "100000000000";

export function disputeStakeFloorMotes(env: Record<string, string | undefined> = process.env): string {
  const raw = env.CASPER_DISPUTE_STAKE_FLOOR_MOTES;
  return raw && /^\d+$/.test(raw) && BigInt(raw) > 0n ? raw : DEFAULT_DISPUTE_STAKE_FLOOR_MOTES;
}

/**
 * Resolver sources whose readings are contestable — a human or a third party could reasonably
 * disagree with the Arbiter's call.
 *
 * `drand` is absent on purpose: a beacon round is verifiable by anyone from public randomness, so
 * a challenge could only ever be wrong. Disputing it would burn a bond to argue with arithmetic.
 */
const CONTESTABLE_SOURCES = new Set(["cspr_cloud", "coingecko", "manual"]);

/** Does this market resolve through the optimistic path? Pure, so the policy is testable. */
export function needsChallengeWindow(
  market: Pick<Market, "totalStakedMotes"> & { resolverSource?: string; category?: string },
  floorMotes: string = disputeStakeFloorMotes(),
): boolean {
  // Meta-markets settle against board math that anyone can recompute; there is no judgement to
  // contest, and delaying them would stall the self-scoring loop.
  if (market.category === "meta") return false;
  const staked = BigInt(market.totalStakedMotes ?? "0");
  if (staked >= BigInt(floorMotes)) return true;
  return market.resolverSource !== undefined && CONTESTABLE_SOURCES.has(market.resolverSource);
}

export interface DisputeStatus {
  marketId: string;
  phase: DisputePhase;
  windows: DisputeWindows;
  state: DisputeState | null;
  /** When the pending phase ends — `null` when nothing is pending. */
  deadlineMs: number | null;
  /** True when `finalize` may be called right now. */
  finalizable: boolean;
}

/**
 * Read a market's dispute status.
 *
 * A read that fails reports `phase: "none"` rather than throwing: the caller's next move on an
 * unreadable dispute is the same as on an absent one — do not finalize — and an exception here
 * would abort the sweep that carries every other market's settlement.
 */
export async function disputeStatus(
  container: Container,
  marketId: string,
  reader: (marketId: string) => Promise<DisputeState | null>,
): Promise<DisputeStatus> {
  const windows = disputeWindowsFromEnv();
  const nowMs = container.clock.now();
  let state: DisputeState | null = null;
  try {
    state = await reader(marketId);
  } catch (err) {
    console.warn("[dispute] could not read state for", JSON.stringify(marketId), err);
    state = null;
  }
  const phase = disputePhase(state, windows, nowMs);
  return {
    marketId,
    phase,
    windows,
    state,
    deadlineMs:
      phase === "challengeable"
        ? (state?.proposedAtMs ?? 0) + windows.challengeWindowMs
        : phase === "voting"
          ? (state?.challengedAtMs ?? state?.proposedAtMs ?? 0) + windows.votingWindowMs
          : null,
    finalizable: canFinalize(state, windows, nowMs),
  };
}
