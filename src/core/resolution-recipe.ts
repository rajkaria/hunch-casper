/**
 * The resolution recipe — a market's resolution rule, as *data*.
 *
 * A recipe says, in one canonical object, exactly how a market resolves: where the deciding datum
 * is read (`source`), what is read (`metric`), how it is judged (`method` + `target`/`comparator`),
 * at what instant (`resolveAtIso`), and over which outcomes (`outcomeKeys`). It is the thing a human
 * (or Genesis) commits to at creation and that the Arbiter later *executes* — the Arbiter fetches
 * the datum and applies the rule; it never decides the rule. An LLM may draft a recipe; the recipe
 * it produces is then frozen and hashed, and from that point resolution is deterministic.
 *
 * ## Why the hash is the whole point (and why it lands here, ahead of S24)
 *
 * S24 commits `recipeHash` on chain at market creation and makes it immutable once the first bet
 * lands, so that a resolution can be *replayed* by a third party: recompute the recipe hash, confirm
 * it matches the chain, re-run the recipe against the same snapshot, and check you get the same
 * winner. For that to work the hash must be **canonical** — two recipes that mean the same thing
 * must hash the same, and any change to what the market actually resolves on must change the hash.
 * This module is that canonicalisation + hash, specified and property-tested now so S24 builds on a
 * settled foundation rather than inventing the format under deadline.
 *
 * Canonicalisation rules (all load-bearing for "semantically equal ⇒ equal hash"):
 *   • object keys are serialised in a fixed order, so insertion order never affects the hash;
 *   • absent optional fields are omitted (not `null`), so "target unset" is one canonical form;
 *   • strings are `NFC`-normalised and the recipe is `version`-stamped, so a format change is a new
 *     version rather than a silent re-interpretation of old hashes;
 *   • `outcomeKeys` order IS significant (it maps to on-chain outcome indices), so it is preserved;
 *   • the `description` is **NOT** hashed — it is advisory human prose that does not affect which
 *     outcome wins, so two markets with the identical resolution rule but different wording share a
 *     hash (correct for dedup and for replay: the hash commits exactly what determines the winner,
 *     nothing cosmetic). Reword freely; the committed hash is stable.
 */

import type { ResolverKind, ResolverSource, ResolverComparator, ResolverBinding } from "./types";
import { sha256Hex } from "./sha256";

/** The current recipe format version. Bump only with a migration; old hashes stay valid at their
 * version. */
export const RECIPE_VERSION = 1 as const;

export interface ResolutionRecipe {
  version: typeof RECIPE_VERSION;
  /** Where the deciding datum is read. */
  source: ResolverSource;
  /** The metric/asset key read from the source (e.g. "cspr_usd", "daily_deploys"). */
  metric: string;
  /** How the datum decides the outcome. */
  method: ResolverKind;
  /** Threshold target in the metric's native unit (string for precision). Omit for non-threshold. */
  target?: string;
  /** Comparator for threshold methods. Omit for non-threshold. */
  comparator?: ResolverComparator;
  /** The instant the datum is snapshotted — ISO 8601, UTC. This is the resolution time. */
  resolveAtIso: string;
  /** Outcome keys, in the ON-CHAIN order (index-significant). */
  outcomeKeys: string[];
  /** One-line human description of the rule (part of the committed recipe, so it is hashed too). */
  description: string;
}

export interface RecipeValidation {
  ok: boolean;
  errors: string[];
}

const METHODS: ResolverKind[] = ["threshold", "direction", "nway_winner", "coin_flip", "agent_metric"];
const SOURCES: ResolverSource[] = ["cspr_cloud", "coingecko", "macro_feed", "drand", "internal"];
const COMPARATORS: ResolverComparator[] = ["gte", "lte"];

/**
 * Validate a recipe's internal consistency (not whether the datum is fetchable — that is the
 * Arbiter's job at resolution time). A threshold needs a target + comparator; a coin flip must read
 * drand; every method needs at least two outcomes; the resolve time must parse.
 */
export function validateRecipe(recipe: ResolutionRecipe): RecipeValidation {
  const errors: string[] = [];
  if (recipe.version !== RECIPE_VERSION) errors.push(`unsupported recipe version ${recipe.version}`);
  if (!SOURCES.includes(recipe.source)) errors.push(`unknown source '${recipe.source}'`);
  if (!METHODS.includes(recipe.method)) errors.push(`unknown method '${recipe.method}'`);
  if (typeof recipe.metric !== "string" || recipe.metric.trim().length === 0) errors.push("metric is required");
  if (!Array.isArray(recipe.outcomeKeys) || recipe.outcomeKeys.length < 2) {
    errors.push("a market needs at least two outcomes");
  } else {
    if (new Set(recipe.outcomeKeys).size !== recipe.outcomeKeys.length) errors.push("duplicate outcome keys");
    if (recipe.outcomeKeys.some((k) => !/^[a-z][a-z0-9_-]{0,31}$/.test(k))) errors.push("invalid outcome key");
  }
  if (recipe.method === "threshold") {
    if (recipe.target === undefined || recipe.target.trim().length === 0) errors.push("threshold needs a target");
    if (recipe.comparator === undefined) errors.push("threshold needs a comparator");
  }
  if (recipe.comparator !== undefined && !COMPARATORS.includes(recipe.comparator)) {
    errors.push(`unknown comparator '${recipe.comparator}'`);
  }
  if (recipe.method === "coin_flip" && recipe.source !== "drand") {
    errors.push("coin_flip must resolve from the drand beacon");
  }
  if (Number.isNaN(Date.parse(recipe.resolveAtIso))) errors.push("resolveAtIso is not a valid ISO timestamp");
  return { ok: errors.length === 0, errors };
}

/**
 * Canonical string form of a recipe — deterministic, key-ordered, optional-fields-omitted. This is
 * the exact byte sequence that gets hashed. Kept as its own function so a test can assert two
 * semantically-equal recipes canonicalise to the identical string, and so the format is inspectable.
 */
export function canonicalizeRecipe(recipe: ResolutionRecipe): string {
  const nfc = (s: string): string => s.normalize("NFC");
  // Fixed key order. Optional fields are included ONLY when present, so "no target" has one form.
  const ordered: Array<[string, unknown]> = [
    ["version", recipe.version],
    ["source", recipe.source],
    ["metric", nfc(recipe.metric)],
    ["method", recipe.method],
  ];
  if (recipe.target !== undefined) ordered.push(["target", nfc(recipe.target)]);
  if (recipe.comparator !== undefined) ordered.push(["comparator", recipe.comparator]);
  ordered.push(["resolveAtIso", recipe.resolveAtIso]);
  ordered.push(["outcomeKeys", recipe.outcomeKeys.map(nfc)]);
  // `description` is deliberately excluded — advisory prose, not a resolution determinant.
  // JSON.stringify over an array of [k,v] pairs is deterministic (array order is fixed above) and
  // escapes strings safely; we build an object literal string with the keys in our order.
  const body = ordered.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",");
  return `{${body}}`;
}

/**
 * The recipe hash — SHA-256 of the canonical form, `sha256:`-prefixed so it is self-describing on
 * chain and in logs. This is the value S24 commits at market creation.
 */
export function recipeHash(recipe: ResolutionRecipe): string {
  return `sha256:${sha256Hex(canonicalizeRecipe(recipe))}`;
}

/**
 * Build a recipe from the catalogue's existing `ResolverBinding` + the market's outcomes and
 * deadline. This is the bridge that lets every *existing* market carry a recipe (and therefore a
 * recipe hash) with no change to the catalogue: the binding already declares source/metric/target,
 * the market already declares outcomes + deadline. So S24 can commit hashes for the whole catalogue,
 * not just human-created markets.
 */
export function recipeFromBinding(
  binding: ResolverBinding,
  outcomeKeys: string[],
  deadlineIso: string,
): ResolutionRecipe {
  const recipe: ResolutionRecipe = {
    version: RECIPE_VERSION,
    source: binding.source,
    metric: binding.metric,
    method: binding.kind,
    resolveAtIso: deadlineIso,
    outcomeKeys,
    description: binding.description,
  };
  if (binding.target !== undefined) recipe.target = binding.target;
  if (binding.comparator !== undefined) recipe.comparator = binding.comparator;
  return recipe;
}
