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
import { attestationFor } from "@/config/attestation";
import { appendAction } from "@/adapters/mock/activity-log";
import type { AgentAction } from "@/adapters/mock/activity-log";
import { chainMode } from "@/config/chain-mode";
import { recipeFromBinding, recipeHash } from "@/core/resolution-recipe";
import { snapshotForOutcome } from "@/core/resolution-replay";
import type { EvidenceBundle } from "@/core/evidence-bundle";
import { recordResolutionEvidence } from "@/adapters/mock/resolution-evidence-ledger";

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

/**
 * Thrown when a market cannot be decided YET — not an error in the resolution, an absence of one.
 * The sweep treats it as "leave this market locked and try again next tick".
 */
class NotYetDecidable extends Error {}

/** Decide a market's outcome: internal meta-markets read the boards; everything else the oracle. */
async function decide(container: Container, market: Market): Promise<Decision> {
  const def = findDefinition(market.slug);
  // An ATTESTED market settles from a published announcement, never from the OraclePort: the mock
  // oracle answers any market id with a deterministic pseudo-random outcome, which would declare
  // the winner of a real contest by hashing a string. No attestation ⇒ no resolution.
  if (def && def.resolver.source === "attested") {
    const attestation = attestationFor(market.slug);
    if (!attestation) {
      throw new NotYetDecidable(
        `market '${market.slug}' resolves from a published announcement — set MARKET_ATTESTATIONS before it can settle`,
      );
    }
    const key = attestation.winningOutcomeKey;
    if (key !== null && !market.outcomes.some((o) => o.key === key)) {
      throw new NotYetDecidable(
        `attested winner '${key}' is not an outcome of '${market.slug}' — check the id before resolving`,
      );
    }
    const source = attestation.evidenceUrl ? ` (${attestation.evidenceUrl})` : "";
    return {
      winningOutcomeKey: key,
      rationale:
        key === null
          ? `Voided: the published result named no single winner${source}. ${attestation.note ?? ""}`.trim()
          : `Attested from the published result${source}. ${attestation.note ?? ""}`.trim(),
      meta: false,
      // An attestation transcribes a published announcement — there is no external read to be
      // wrong about, so it neither flatters nor penalises the Arbiter's accuracy.
      accurate: true,
    };
  }
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
/**
 * The vault's `AlreadySettled` (User error: 5) — the chain resolved this market before the
 * mirror did, e.g. a manual operator `resolve-v2`. Distinct from every other revert: retrying
 * cannot succeed, and the mirror can settle safely because both sides answer from the same
 * recipe. Everything else (NotOracle, RPC outage, gas) stays fatal to THIS market's attempt so
 * the sweep's per-market guard logs it and the next tick retries.
 */
function chainAlreadySettled(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /User error:\s*5\b/.test(message);
}

export async function resolveMarket(container: Container, slug: string): Promise<AgentAction | null> {
  const market = await container.store.get(slug, container.network);
  if (!market) return null;

  // Idempotency — never re-resolve a settled market (would burn gas + could echo a new winner).
  const existing = await container.store.settlementFor(market.id);
  if (existing) return null;

  let decision: Decision;
  try {
    decision = await decide(container, market);
  } catch (err) {
    if (err instanceof NotYetDecidable) {
      // Locked and waiting is the correct resting state for a market whose result is not out.
      console.warn("[arbiter] not resolving", JSON.stringify(slug), "—", err.message);
      return null;
    }
    throw err;
  }
  const { winningOutcomeKey, rationale, meta, accurate } = decision;

  // Post the resolution on-chain. A void (null) has no winning outcome → no on-chain resolve tx
  // (the vault's `void()` path is a distinct call; off-chain we still refund via the engine).
  let deployHash: string | undefined;
  let explorerUrl: string | undefined;
  if (winningOutcomeKey !== null) {
    try {
      const res = await container.chain.resolveMarket({
        marketId: market.id,
        winningOutcomeKey,
        oracleId: ARBITER_ID,
      });
      deployHash = res.deployHash;
      explorerUrl = res.explorerUrl;
    } catch (err) {
      // The vault settled this market before the mirror did (e.g. a manual operator
      // `resolve-v2`). Both sides resolve by the same recipe, so settle the mirror and stop —
      // retrying a transaction that can only revert again would burn oracle gas every tick.
      if (!chainAlreadySettled(err)) throw err;
    }
  }

  // Settle off-chain through the pure engine — the exact numbers the on-chain claim() mirrors.
  await container.store.settle(market.id, winningOutcomeKey);

  // S24: publish a replayable evidence bundle and record its hash. The recipe is derived from the
  // market's declarative resolver (the same rule the catalogue ships), the snapshot is the datum
  // that justifies the outcome, and the bundle is content-addressed so anyone can fetch it, verify
  // the hash, and replay the recipe to confirm the winner. In real mode the vault's `commit_recipe`
  // / `commit_bundle` entrypoints anchor these hashes on chain (see contracts/src/hunch_vault.rs).
  const evidence = await publishEvidence(container, market, winningOutcomeKey, rationale);

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

  // Anchor the recipe + evidence hashes on chain (S24), so this resolution is replayable from the
  // chain alone rather than from this server's word for it. Deliberately last, and deliberately
  // unable to fail the resolution: winners have already been paid, and withholding a settled
  // payout because a metadata write reverted would strand user money to protect a hash.
  const anchor = evidence ? await anchorResolution(container, market.id, evidence) : null;

  // Notify every contract bound to this market's resolution (S34/W3). Same placement and same
  // rule as anchoring: after the money has moved, and structurally unable to fail the resolution.
  // A consumer integration that breaks must never be able to hold a settled payout hostage — that
  // is the whole reason dispatch emits events instead of calling consumers back.
  const dispatched = await dispatchResolutionHooks(container, market.id, winningOutcomeKey, evidence?.bundleHash);

  return appendAction({
    agent: "Arbiter",
    kind: "market_resolved",
    marketId: market.id,
    marketTitle: market.title,
    outcomeKey: winningOutcomeKey ?? undefined,
    narration: narration || rationale,
    deployHash,
    explorerUrl,
    simulated: chainMode() !== "real",
    recipeHash: evidence?.recipeHash,
    evidenceBundleHash: evidence?.bundleHash,
    anchorDeployHash: anchor?.recipeDeployHash ?? anchor?.bundleDeployHash,
    hookDispatchDeployHash: dispatched ?? undefined,
  });
}

/**
 * Fire the `ResolutionHook` for a finalised market, so consumer protocols can act on the outcome.
 *
 * Total by construction, exactly like `anchorResolution`: every failure returns `null`. Three
 * distinct non-events are folded into that null on purpose — mock mode, no hook deployed, and a
 * market that was already dispatched — because none of them is a problem the resolution can or
 * should do anything about. `dispatch` is idempotent per market on chain, so a retried
 * finalisation cannot double-fire a consumer even if this runs twice.
 */
async function dispatchResolutionHooks(
  container: Container,
  marketId: string,
  winningOutcomeKey: string | null,
  bundleHash: string | undefined,
): Promise<string | null> {
  if (chainMode() !== "real") return null;
  if (!container.chain.dispatchResolution) return null;
  // A voided market has no decided outcome, so there is nothing a consumer could act on. Sending
  // an empty string would be worse than silence: it reads as a real outcome that matches nothing.
  if (!winningOutcomeKey) return null;
  try {
    const result = await container.chain.dispatchResolution({
      marketId,
      decidedOutcome: winningOutcomeKey,
      bundleHash: bundleHash ?? "",
    });
    if (result.skipped) {
      console.warn("[arbiter] hooks not dispatched:", JSON.stringify({ marketId, why: result.skipped }));
      return null;
    }
    return result.deployHash ?? null;
  } catch (err) {
    console.warn("[arbiter] hook dispatch threw — the resolution still paid out:", JSON.stringify({ marketId }), err);
    return null;
  }
}

/**
 * Anchor a resolution's hashes on chain. Total by construction — every failure returns `null`
 * rather than throwing, because this runs after the money has already moved.
 */
async function anchorResolution(
  container: Container,
  marketId: string,
  evidence: { recipeHash: string; bundleHash: string },
): Promise<{ recipeDeployHash?: string; bundleDeployHash?: string } | null> {
  if (chainMode() !== "real") return null;
  try {
    const result = await container.chain.anchorResolution({
      marketId,
      recipeHash: evidence.recipeHash,
      bundleHash: evidence.bundleHash,
    });
    if (result.skipped) {
      console.warn("[arbiter] resolution not anchored:", JSON.stringify({ marketId, why: result.skipped }));
    }
    return result;
  } catch (err) {
    console.warn("[arbiter] anchoring threw — the resolution still paid out:", JSON.stringify({ marketId }), err);
    return null;
  }
}

/**
 * Build + store the evidence bundle for a resolution and record the market→hash linkage. Returns
 * the committed hashes, or `null` if the market has no catalogue definition (nothing to derive a
 * recipe from). Best-effort: an evidence failure must never block settlement, which has already
 * happened by the time this runs.
 */
async function publishEvidence(
  container: Container,
  market: Market,
  winningOutcomeKey: string | null,
  rationale: string,
): Promise<{ recipeHash: string; bundleHash: string } | null> {
  const def = findDefinition(market.slug);
  if (!def) return null;
  try {
    const recipe = recipeFromBinding(def.resolver, market.outcomes.map((o) => o.key), def.deadlineIso);
    const rHash = recipeHash(recipe);
    const bundle: EvidenceBundle = {
      version: 1,
      marketId: market.id,
      recipeHash: rHash,
      winningOutcomeKey,
      resolvedAtIso: new Date().toISOString(),
      sources: [{ source: recipe.source, metric: recipe.metric, reference: def.resolver.description }],
      snapshot: snapshotForOutcome(recipe, winningOutcomeKey),
      reasoning: rationale,
    };
    const stored = await container.evidence.put(bundle);
    recordResolutionEvidence({
      marketId: market.id,
      recipeHash: rHash,
      bundleHash: stored.hash,
      uri: stored.uri,
      resolvedAtIso: bundle.resolvedAtIso,
    });
    return { recipeHash: rHash, bundleHash: stored.hash };
  } catch {
    return null;
  }
}

/**
 * Sweep the catalogue and resolve every market whose betting window has closed (past deadline →
 * `locked`) and that is not yet settled. This is the unattended path: a cron fires it and any
 * matured market settles automatically. Meta-markets (future weekly deadlines) are left for the
 * explicit weekly close (`resolveMarket` by slug) so Prophets can bet them until the window ends.
 *
 * `deadlineMs` (epoch) bounds the sweep: each resolution waits on chain confirmations (up to
 * 150s each, several transactions), so an unbounded sweep with a few slow markets outlives the
 * route's own `maxDuration` — and a platform kill is not a JS exception, so the caller's
 * flush-on-error never runs and everything already resolved on chain is dropped from the mirror.
 * Stopping early is safe: unresolved markets stay `locked` and the next sweep retries them.
 */
export async function runArbiterSweep(container: Container, deadlineMs?: number): Promise<AgentAction[]> {
  const markets = await container.store.list({ network: container.network });
  const actions: AgentAction[] = [];
  for (const m of markets) {
    if (m.status !== "locked") continue; // only matured, still-open markets
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      console.warn(`[arbiter] sweep time budget exhausted — remaining locked markets retry next tick`);
      break;
    }
    // Per-market isolation: one market whose resolve fails (bad oracle key, revert, RPC outage)
    // must not abort the sweep — that would let a single broken market freeze every OTHER
    // market's settlement and kill the tick that carries the whole economy. No settlement is
    // stored for the failed market, so the next sweep retries it.
    try {
      const action = await resolveMarket(container, m.slug);
      if (action) actions.push(action);
    } catch (err) {
      console.error(
        `[arbiter] resolve of '${m.slug}' failed — skipped this tick, retrying next:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return actions;
}
