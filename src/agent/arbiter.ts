/**
 * Arbiter — the oracle agent, now autonomous. It closes the economy's loop: finds markets whose
 * window has ended, reads the deciding datum, posts the winning outcome on-chain, settles the
 * pools through the pure payout engine, and updates its own on-chain reputation. Because a wrong
 * call costs bettors real money, that reputation has economic teeth — the RWA-oracle thesis, live.
 *
 * Two resolution paths, one code path:
 *   • external markets (price / macro / chain data) → `OraclePort.read` (mock hash-picks; the real
 *     adapter reads CSPR.cloud / price feeds);
 *   • meta-markets (`resolver.source === "internal"`) → the economy's own boards, via the pure
 *     `resolveMetaMarket` — the recursive twist where agents' bets on agents settle against the
 *     agent PnL board and the Arbiter's own accuracy.
 *
 * The Arbiter never lets an LLM pick the outcome; the narration is advisory flavour only. Every
 * resolution is logged to the activity feed with its explorer link.
 */

import type { Container } from "@/lib/container";
import type { Market } from "@/core/types";
import { computeAgentLeaderboard } from "@/core/agent-leaderboard";
import { resolveMetaMarket } from "@/core/meta-resolution";
import type { EconomyBoards } from "@/core/meta-resolution";
import { findDefinition } from "@/adapters/mock/market-source";
import { appendAction } from "@/adapters/mock/activity-log";
import type { AgentAction } from "@/adapters/mock/activity-log";

const ARBITER_ID = "arbiter";

/** Snapshot the economy's own boards — the deciding data for meta-markets. */
export async function economyBoards(container: Container): Promise<EconomyBoards> {
  const agentPnl = computeAgentLeaderboard(await container.store.settledEntries(container.network));
  const rep = await container.oracle.reputationOf(ARBITER_ID);
  return { agentPnl, arbiterAccuracyPct: rep.accuracyBps / 100 };
}

interface Decision {
  /** Winning outcome key, or `null` to void (refund) — never undefined once decided. */
  winningOutcomeKey: string | null;
  /** One-line human rationale (advisory; seeds the narration). */
  rationale: string;
  /** Whether this was a meta-market resolved from the economy's own state. */
  meta: boolean;
  /**
   * Whether the call was accurate against ground truth — recorded on the Arbiter's reputation so a
   * wrong external read genuinely costs it accuracy. Meta-markets settle deterministically from the
   * boards (no external datum to be wrong about) so they are accurate by construction.
   */
  accurate: boolean;
}

/** Decide a market's outcome: internal meta-markets read the boards; everything else the oracle. */
async function decide(container: Container, market: Market): Promise<Decision> {
  const def = findDefinition(market.slug);
  if (def && def.resolver.source === "internal") {
    const boards = await economyBoards(container);
    const key = resolveMetaMarket(def.resolver, market.outcomes.map((o) => o.key), boards);
    return {
      winningOutcomeKey: key ?? null,
      rationale: def.resolver.description,
      meta: true,
      accurate: true, // deterministic board math — nothing external to be wrong about
    };
  }
  const reading = await container.oracle.read(market.id);
  return {
    winningOutcomeKey: reading.winningOutcomeKey,
    rationale: reading.rationale,
    meta: false,
    accurate: reading.accurate ?? true,
  };
}

/**
 * Resolve one market (by slug) as the Arbiter. Idempotent: a market that already has a settlement
 * is skipped (returns `null`). Posts on-chain (unless voided), settles off-chain, records the
 * resolution against the Arbiter's reputation, and logs a narrated `market_resolved` action.
 */
export async function resolveMarket(container: Container, slug: string): Promise<AgentAction | null> {
  const market = await container.store.get(slug, container.network);
  if (!market) return null;

  // Idempotency — never re-resolve a settled market (would burn gas + could echo a new winner).
  const existing = await container.store.settlementFor(market.id);
  if (existing) return null;

  const { winningOutcomeKey, rationale, meta, accurate } = await decide(container, market);

  // Post the resolution on-chain. A void (null) has no winning outcome → no on-chain resolve tx
  // (the vault's `void()` path is a distinct call; off-chain we still refund via the engine).
  let deployHash: string | undefined;
  let explorerUrl: string | undefined;
  if (winningOutcomeKey !== null) {
    const res = await container.chain.resolveMarket({
      marketId: market.id,
      winningOutcomeKey,
      oracleId: ARBITER_ID,
    });
    deployHash = res.deployHash;
    explorerUrl = res.explorerUrl;
  }

  // Settle off-chain through the pure engine — the exact numbers the on-chain claim() mirrors.
  await container.store.settle(market.id, winningOutcomeKey);

  // Record the resolution against the Arbiter's reputation. External reads can be wrong (the mock
  // marks a deterministic minority inaccurate), so a bad call genuinely costs accuracy — the
  // reputation has two-sided teeth. Meta-markets resolve from board math and are accurate by
  // construction. A dispute layer could later revise a contested call.
  await container.oracle.recordResolution(ARBITER_ID, market.id, accurate);

  const label = winningOutcomeKey
    ? market.outcomes.find((o) => o.key === winningOutcomeKey)?.label ?? winningOutcomeKey
    : "void — refunded";
  const narration = (
    await container.llm.complete({
      system:
        "You are Arbiter, the reputation-staked oracle resolving a Casper prediction market. One measured, first-person sentence.",
      prompt: `Explain your resolution of "${market.title}" as "${label}". Basis: ${rationale}${meta ? " (resolved from the economy's own leaderboards)." : "."}`,
    })
  ).trim();

  return appendAction({
    agent: "Arbiter",
    kind: "market_resolved",
    marketId: market.id,
    marketTitle: market.title,
    outcomeKey: winningOutcomeKey ?? undefined,
    narration: narration || rationale,
    deployHash,
    explorerUrl,
  });
}

/**
 * Sweep the catalogue and resolve every market whose betting window has closed (past deadline →
 * `locked`) and that is not yet settled. This is the unattended path: a cron fires it and any
 * matured market settles automatically. Meta-markets (future weekly deadlines) are left for the
 * explicit weekly close (`resolveMarket` by slug) so Prophets can bet them until the window ends.
 */
export async function runArbiterSweep(container: Container): Promise<AgentAction[]> {
  const markets = await container.store.list({ network: container.network });
  const actions: AgentAction[] = [];
  for (const m of markets) {
    if (m.status !== "locked") continue; // only matured, still-open markets
    const action = await resolveMarket(container, m.slug);
    if (action) actions.push(action);
  }
  return actions;
}
