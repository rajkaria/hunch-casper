/**
 * Meta-market resolution — the recursive heart of the economy. A meta-market (`resolver.source ===
 * "internal"`) resolves not from external data but from the economy's OWN state: the agent PnL
 * board and the Arbiter's accuracy. This is what lets "agents bet on agents" actually settle:
 *   • `prophet_pnl` (n-way) → the Prophet with the highest realized PnL this window wins;
 *   • `arbiter_accuracy_pct` (threshold) → YES iff the Arbiter's accuracy clears the target.
 *
 * Pure and deterministic: given the same boards it returns the same winner — never an LLM (the
 * narration is advisory, the money is math). The Arbiter reads the boards, calls this, and posts
 * the result on-chain exactly like any other resolution.
 */

import type { ResolverBinding } from "@/core/types";
import type { AgentPnl } from "@/core/agent-leaderboard";

/** The economy's own leaderboards — the deciding data for meta-markets. */
export interface EconomyBoards {
  /** Agent PnL board, RANKED best-first (as `computeAgentLeaderboard` returns it; `agent:<key>` ids). */
  agentPnl: readonly AgentPnl[];
  /** Arbiter resolution accuracy as a percentage (e.g. 96.09). */
  arbiterAccuracyPct: number;
}

const AGENT_PREFIX = "agent:";

/**
 * Decide a meta-market's winning outcome from the boards, or `null` to void (refund) when the
 * board can't decide (e.g. no Prophet has any settled activity yet).
 *
 * Returns `undefined` when the binding is not an internal/meta resolver — callers should fall back
 * to the external oracle read for those.
 */
export function resolveMetaMarket(
  resolver: ResolverBinding,
  outcomeKeys: readonly string[],
  boards: EconomyBoards,
): string | null | undefined {
  if (resolver.source !== "internal") return undefined;

  switch (resolver.metric) {
    case "prophet_pnl": {
      // Winner = the top-RANKED candidate on the PnL board. The board is the single source of
      // ranking truth (PnL desc, then its own tie-break), so we simply walk it best-first and
      // return the first outcome key that is one of this market's candidates — the market's exact
      // semantics ("which Prophet tops the board"). Consistent with the board by construction.
      const candidates = new Set(outcomeKeys.map((k) => `${AGENT_PREFIX}${k}`));
      for (const agent of boards.agentPnl) {
        if (candidates.has(agent.agent)) return agent.agent.slice(AGENT_PREFIX.length);
      }
      return null; // no candidate has any settled activity yet → void/refund
    }
    case "arbiter_accuracy_pct": {
      const target = Number(resolver.target ?? "0");
      if (!Number.isFinite(target)) return null;
      const meets =
        resolver.comparator === "lte"
          ? boards.arbiterAccuracyPct <= target
          : boards.arbiterAccuracyPct >= target;
      // Threshold meta-markets are YES/NO by construction.
      const yes = outcomeKeys.includes("yes") ? "yes" : outcomeKeys[0];
      const no = outcomeKeys.includes("no") ? "no" : outcomeKeys[outcomeKeys.length - 1];
      return meets ? yes : no;
    }
    default:
      // Unknown internal metric — void rather than guess (never fabricate a money outcome).
      return null;
  }
}
