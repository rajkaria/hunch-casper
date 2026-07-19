/**
 * Copy-betting (S29) — the retail hook. One click mirrors a registered agent's FUTURE positions,
 * sized by the follower's own stake budget, and the followed agent earns a fee on the volume it
 * drives. Pure and deterministic: given a follow config and a position the agent just took, this
 * decides whether and how much to mirror, and splits the fee — so the whole thing is testable
 * without a chain, and the money numbers are integer-exact.
 *
 * ## Guardrails (all enforced here, all tested)
 *
 *   • **Meta-markets are never mirrored.** A meta-market resolves against the agent leaderboards, so
 *     mirroring flow into one would let a followed agent's own scoring be moved by its followers — a
 *     reflexive loop, the same invariant the Prophet fleet and the vault already hold. A mirror on a
 *     meta-market is refused, provably (a test asserts it can never be planned).
 *   • **Per-follower cap.** Every mirror is clamped to the follower's per-bet ceiling, so following a
 *     whale agent can't drain a follower in one position.
 *   • **Unwind on deactivation.** If the follow is inactive or the agent has deactivated, no new
 *     mirror is planned — the follower stops copying a departed agent automatically.
 *
 * Mirrors copy FUTURE positions only (this plans from a position as it happens); nothing here reads
 * or back-fills an agent's history, so a follower can never be signed up into past losses.
 */

import type { MarketCategory } from "./types";

export interface FollowConfig {
  follower: string;
  /** The registered agent being followed (ledger id, e.g. "agent:momentum" or a public key). */
  agentId: string;
  /**
   * Scale applied to the agent's stake to size the mirror, in basis points (10_000 = 1×). A
   * follower who wants to mirror at a quarter of the agent's size sets 2_500.
   */
  scaleBps: number;
  /** Hard ceiling on any single mirrored bet, in motes. */
  perBetCapMotes: string;
  /** Whether this follow is active. */
  active: boolean;
}

export interface AgentPosition {
  marketId: string;
  category: MarketCategory;
  outcomeKey: string;
  /** The agent's own stake on this position, in motes. */
  agentStakeMotes: string;
}

export type MirrorPlan =
  | {
      mirror: true;
      follower: string;
      agentId: string;
      marketId: string;
      outcomeKey: string;
      amountMotes: string;
    }
  | { mirror: false; reason: "inactive" | "agent-deactivated" | "meta-excluded" | "zero-size" | "capped-to-zero" };

/**
 * Plan a follower's mirror of an agent position. `agentActive` reflects the registry (an agent that
 * has deactivated its bond is no longer copyable — the unwind rule). Returns the mirror bet to place
 * (which then goes through the SAME x402 money path as any bet) or a structured refusal.
 */
export function planMirror(follow: FollowConfig, position: AgentPosition, agentActive: boolean): MirrorPlan {
  if (!follow.active) return { mirror: false, reason: "inactive" };
  if (!agentActive) return { mirror: false, reason: "agent-deactivated" };
  // The load-bearing invariant: mirrored flow can NEVER touch a meta-market.
  if (position.category === "meta") return { mirror: false, reason: "meta-excluded" };

  const agentStake = BigInt(position.agentStakeMotes);
  if (agentStake <= 0n) return { mirror: false, reason: "zero-size" };

  // Size = agentStake · scaleBps / 10_000, clamped to the per-bet cap.
  const scaled = (agentStake * BigInt(follow.scaleBps)) / 10_000n;
  const cap = BigInt(follow.perBetCapMotes);
  const amount = scaled > cap ? cap : scaled;
  if (amount <= 0n) return { mirror: false, reason: "capped-to-zero" };

  return {
    mirror: true,
    follower: follow.follower,
    agentId: follow.agentId,
    marketId: position.marketId,
    outcomeKey: position.outcomeKey,
    amountMotes: amount.toString(),
  };
}

export interface CopyFeeSplit {
  /** Total fee taken on the mirrored volume, in motes. */
  feeMotes: string;
  /** The followed agent's share, in motes. */
  agentMotes: string;
  /** The platform treasury's share, in motes. */
  platformMotes: string;
}

/**
 * Split the copy fee on a mirrored bet's volume. `copyFeeBps` is the fee on the mirrored volume;
 * `agentShareBps` is the followed agent's cut of THAT fee. Conservation is exact: `agentMotes +
 * platformMotes == feeMotes`, with integer-division dust assigned to the platform (never overpaying
 * the agent). Property-tested + mirrored by the on-chain `copy_betting.rs` split.
 */
export function splitCopyFee(volumeMotes: string, copyFeeBps: number, agentShareBps: number): CopyFeeSplit {
  if (copyFeeBps < 0 || copyFeeBps >= 10_000) throw new Error("copyFeeBps must be in [0, 10000)");
  if (agentShareBps < 0 || agentShareBps > 10_000) throw new Error("agentShareBps must be in [0, 10000]");
  const volume = BigInt(volumeMotes);
  const fee = (volume * BigInt(copyFeeBps)) / 10_000n;
  const agent = (fee * BigInt(agentShareBps)) / 10_000n;
  const platform = fee - agent; // remainder (incl. dust) → platform, so agent is never overpaid
  return { feeMotes: fee.toString(), agentMotes: agent.toString(), platformMotes: platform.toString() };
}
