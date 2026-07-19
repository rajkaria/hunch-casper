/**
 * The resolution replay harness — the deterministic re-execution that makes a resolution auditable.
 *
 * Given a frozen recipe and the numeric snapshot the Arbiter read (both preserved in the evidence
 * bundle), `replayRecipe` recomputes the winning outcome with pure arithmetic — no oracle, no LLM,
 * no network. A third party (or CI) can therefore take a settled market's committed recipe hash +
 * published bundle and confirm, independently, that the recorded winner is the one the rule
 * produces. If replay disagrees with what was recorded, that is drift, and `verifyResolution`
 * reports it — the check CI runs over every fixture so a resolution can never silently diverge from
 * its own stated rule.
 *
 * This is intentionally the SAME logic the mock oracle would apply, lifted into a pure function of
 * (recipe, snapshot) so it can be run by anyone, not just the resolver.
 */

import type { ResolutionRecipe } from "./resolution-recipe";
import type { EvidenceBundle } from "./evidence-bundle";
import { recipeHash } from "./resolution-recipe";
import { bundleHash } from "./evidence-bundle";

export type ReplayOutcome =
  | { decided: true; winningOutcomeKey: string | null }
  | { decided: false; reason: string };

/** The snapshot key a recipe reads for its primary metric. */
export function snapshotKeyFor(recipe: ResolutionRecipe): string {
  return recipe.metric;
}

/**
 * Re-execute a recipe against a snapshot. Returns the winning outcome key (or `null` for a void
 * when the snapshot cannot decide), or `decided: false` when the recipe/snapshot pairing is not
 * replayable (missing datum, unsupported method for this harness).
 *
 * Supported deterministically here:
 *   • `threshold` — compares `snapshot[metric]` to `target` via `comparator`; YES/NO by outcome[0/1].
 *   • `direction` — sign of `snapshot[metric]` (a signed delta) → up/first vs down/second.
 *   • `nway_winner` / `coin_flip` — the snapshot names the winning key directly under `metric`.
 *   • `agent_metric` — the snapshot names the winning key directly (board-derived, precomputed).
 */
export function replayRecipe(recipe: ResolutionRecipe, snapshot: Record<string, string>): ReplayOutcome {
  const key = snapshotKeyFor(recipe);
  const raw = snapshot[key];

  switch (recipe.method) {
    case "threshold": {
      if (raw === undefined) return { decided: false, reason: `snapshot missing '${key}'` };
      if (recipe.target === undefined || recipe.comparator === undefined) {
        return { decided: false, reason: "threshold recipe missing target/comparator" };
      }
      const value = Number(raw);
      const target = Number(recipe.target);
      if (!Number.isFinite(value) || !Number.isFinite(target)) {
        return { decided: false, reason: "non-numeric threshold datum" };
      }
      const met = recipe.comparator === "gte" ? value >= target : value <= target;
      // Convention: outcomeKeys[0] is the affirmative (YES/UP), [1] the negative (NO/DOWN).
      return { decided: true, winningOutcomeKey: met ? recipe.outcomeKeys[0] : recipe.outcomeKeys[1] };
    }
    case "direction": {
      if (raw === undefined) return { decided: false, reason: `snapshot missing '${key}'` };
      const delta = Number(raw);
      if (!Number.isFinite(delta)) return { decided: false, reason: "non-numeric direction datum" };
      if (delta === 0) return { decided: true, winningOutcomeKey: null }; // flat → void
      return { decided: true, winningOutcomeKey: delta > 0 ? recipe.outcomeKeys[0] : recipe.outcomeKeys[1] };
    }
    case "nway_winner":
    case "coin_flip":
    case "agent_metric": {
      // The snapshot names the winning outcome key directly (drand beacon result, board winner).
      if (raw === undefined) return { decided: false, reason: `snapshot missing '${key}'` };
      if (raw === "__void__") return { decided: true, winningOutcomeKey: null };
      if (!recipe.outcomeKeys.includes(raw)) {
        return { decided: false, reason: `snapshot winner '${raw}' is not an outcome` };
      }
      return { decided: true, winningOutcomeKey: raw };
    }
  }
}

/**
 * The inverse of `replayRecipe`: synthesize a snapshot that replays to `winningOutcomeKey`. Used
 * when building an evidence bundle — the bundle must carry a snapshot the recipe replays to the
 * recorded winner, so a third party's replay reproduces it. In real mode the oracle adapter
 * supplies the ACTUAL read datum here instead; this deterministic synthesis is the mock/demo path
 * and the property is the same: `replayRecipe(recipe, snapshotForOutcome(recipe, k)) === k`.
 */
export function snapshotForOutcome(
  recipe: ResolutionRecipe,
  winningOutcomeKey: string | null,
): Record<string, string> {
  const key = snapshotKeyFor(recipe);
  switch (recipe.method) {
    case "threshold": {
      const target = Number(recipe.target ?? "0");
      if (winningOutcomeKey === null) return { [key]: "__void__" };
      const affirmative = winningOutcomeKey === recipe.outcomeKeys[0];
      const gte = recipe.comparator === "gte";
      // gte: met at value >= target; not-met at value < target. lte mirrors.
      const value = affirmative ? target : gte ? target - 1 : target + 1;
      return { [key]: String(value) };
    }
    case "direction": {
      if (winningOutcomeKey === null) return { [key]: "0" };
      return { [key]: winningOutcomeKey === recipe.outcomeKeys[0] ? "1" : "-1" };
    }
    case "nway_winner":
    case "coin_flip":
    case "agent_metric":
      return { [key]: winningOutcomeKey ?? "__void__" };
  }
}

export interface ReplayVerification {
  ok: boolean;
  /** Individual checks, for a precise failure message. */
  recipeHashMatches: boolean;
  bundleHashMatches: boolean;
  outcomeMatches: boolean;
  /** What replay produced (present when the recipe was replayable). */
  replayedOutcomeKey?: string | null;
  reason?: string;
}

/**
 * Full audit of a settled resolution: confirm the bundle's stored recipe hash equals the recipe's
 * computed hash, confirm the bundle's own content hash matches the claimed one, and confirm that
 * replaying the recipe against the bundle's snapshot reproduces the recorded winner. All three must
 * hold for the resolution to be verifiably correct.
 */
export function verifyResolution(
  recipe: ResolutionRecipe,
  bundle: EvidenceBundle,
  claimedBundleHash: string,
): ReplayVerification {
  const recipeHashMatches = bundle.recipeHash === recipeHash(recipe);
  const bundleHashMatches = bundleHash(bundle) === claimedBundleHash;
  const replay = replayRecipe(recipe, bundle.snapshot);
  if (!replay.decided) {
    return {
      ok: false,
      recipeHashMatches,
      bundleHashMatches,
      outcomeMatches: false,
      reason: replay.reason,
    };
  }
  const outcomeMatches = replay.winningOutcomeKey === bundle.winningOutcomeKey;
  return {
    ok: recipeHashMatches && bundleHashMatches && outcomeMatches,
    recipeHashMatches,
    bundleHashMatches,
    outcomeMatches,
    replayedOutcomeKey: replay.winningOutcomeKey,
    reason: outcomeMatches ? undefined : "replayed outcome differs from the recorded winner",
  };
}
