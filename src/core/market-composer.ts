/**
 * The market composer — a human's claim, plus a declared resolution rule, becomes a validated,
 * deduplicated, deterministically-hashed market definition.
 *
 * The division of labour is the whole point, and it is the same discipline as everywhere else: the
 * human (helped by an LLM's advisory framing) supplies *what* to ask and *how* it resolves; this
 * module turns that into a `MarketDefinition` + a `ResolutionRecipe` + its canonical hash, and
 * refuses anything that (a) the category policy forbids, (b) is an invalid/unresolvable recipe, or
 * (c) duplicates an existing market. The LLM writes the subtitle; it never picks the outcome, the
 * source, or the target — those are data the recipe freezes and the hash commits.
 *
 * Pure except for the advisory LLM call (mock-backed in tests), so the exact rejections and the
 * exact hash are unit-tested without a network.
 */

import type { CasperNetwork } from "@/config/network";
import type { LlmClient } from "@/ports/llm";
import type { MarketDefinition } from "@/core/catalogue";
import type {
  MarketOutcome,
  ResolverBinding,
  ResolverComparator,
  ResolverKind,
  ResolverSource,
} from "@/core/types";
import {
  type ResolutionRecipe,
  validateRecipe,
  recipeHash,
  recipeFromBinding,
} from "@/core/resolution-recipe";
import { assessMarket } from "@/core/category-policy";

export interface ComposeMarketInput {
  /** The human's claim / question, e.g. "Will CSPR cross $0.10 by Sept 1?". */
  claim: string;
  /** The creator's identity (public key / platform id) — bound as the market's creator. */
  creator: string;
  network: CasperNetwork;
  /** Monotone sequence for a unique slug (the route passes the created-count). */
  seq: number;
  deadlineIso: string;
  /** The declared resolution rule. */
  source: ResolverSource;
  metric: string;
  method: ResolverKind;
  target?: string;
  comparator?: ResolverComparator;
  /** Outcomes; defaults to YES/NO. Order is on-chain-significant. */
  outcomes?: MarketOutcome[];
  /** Parimutuel fee bps; defaults to 200. */
  feeBps?: number;
}

export type ComposeReason = "invalid-input" | "category" | "invalid-recipe" | "duplicate";

export type ComposeResult =
  | { ok: true; definition: MarketDefinition; recipe: ResolutionRecipe; recipeHash: string }
  | { ok: false; reason: ComposeReason; message: string };

const YES_NO: MarketOutcome[] = [
  { key: "yes", label: "Yes" },
  { key: "no", label: "No" },
];

const DEFAULT_FEE_BPS = 200;
const MAX_CLAIM_CHARS = 200;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/** Normalise a title for duplicate comparison: lowercase, collapse whitespace, strip punctuation. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Is a proposed market a duplicate of any existing one? True when the recipe hashes match (the same
 * rule, the strong signal) OR the normalised titles match (the same question asked twice). Existing
 * markets are compared by the recipe hash recomputed from their binding, so a human market and a
 * catalogue market with the identical rule collide.
 */
export function findDuplicate(
  proposed: { recipeHash: string; title: string },
  existing: MarketDefinition[],
): MarketDefinition | null {
  const normTitle = normalizeTitle(proposed.title);
  for (const def of existing) {
    const existingRecipe = recipeFromBinding(def.resolver, def.outcomes.map((o) => o.key), def.deadlineIso);
    if (recipeHash(existingRecipe) === proposed.recipeHash) return def;
    if (normalizeTitle(def.title) === normTitle) return def;
  }
  return null;
}

/**
 * Compose a market. Returns the built definition + recipe + hash, or a structured rejection the
 * create route turns into a user-facing 4xx.
 */
export async function composeMarket(
  input: ComposeMarketInput,
  deps: { llm: LlmClient; existing: MarketDefinition[] },
): Promise<ComposeResult> {
  const claim = input.claim?.trim() ?? "";
  if (claim.length === 0) return { ok: false, reason: "invalid-input", message: "a claim is required" };
  if (claim.length > MAX_CLAIM_CHARS) {
    return { ok: false, reason: "invalid-input", message: `claim must be ${MAX_CLAIM_CHARS} characters or fewer` };
  }

  // Moderation FIRST — a prohibited claim never reaches the recipe or the LLM.
  const verdict = assessMarket(claim);
  if (!verdict.allowed) {
    return { ok: false, reason: "category", message: verdict.message ?? "market not allowed" };
  }

  const outcomes = input.outcomes && input.outcomes.length >= 2 ? input.outcomes : YES_NO;
  const outcomeKeys = outcomes.map((o) => o.key);

  const recipe: ResolutionRecipe = recipeFromBinding(
    buildBinding(input, claim),
    outcomeKeys,
    input.deadlineIso,
  );
  const validation = validateRecipe(recipe);
  if (!validation.ok) {
    return { ok: false, reason: "invalid-recipe", message: validation.errors.join("; ") };
  }

  const hash = recipeHash(recipe);
  const title = claim.endsWith("?") ? claim : `${claim}?`;

  const duplicate = findDuplicate({ recipeHash: hash, title }, deps.existing);
  if (duplicate) {
    return { ok: false, reason: "duplicate", message: `duplicates existing market '${duplicate.slug}'` };
  }

  // Advisory framing only — the subtitle. Never the money path; failure falls back to a plain line.
  let subtitle = `Community market · resolves from ${recipe.source}`;
  try {
    const framed = (
      await deps.llm.complete({
        system: "You write one-line, neutral subtitles for prediction markets. No hype, under 18 words.",
        prompt: `Subtitle for the market: "${title}" resolving from ${recipe.source}/${recipe.metric}.`,
      })
    ).trim();
    if (framed.length > 0) subtitle = framed.slice(0, 140);
  } catch {
    /* keep the deterministic fallback */
  }

  const definition: MarketDefinition = {
    slug: `user-${slugify(claim)}-${input.seq}`,
    title,
    subtitle,
    category: "provably-fair",
    outcomes,
    feeBps: input.feeBps ?? DEFAULT_FEE_BPS,
    cadence: "one-shot",
    resolver: buildBinding(input, claim),
    deadlineIso: input.deadlineIso,
    // Even seed pools so the market opens with symmetric odds; the fleet seeds real liquidity next.
    seedPoolMotes: Object.fromEntries(outcomeKeys.map((k) => [k, "500000000000"])),
  };

  return { ok: true, definition, recipe, recipeHash: hash };
}

function buildBinding(input: ComposeMarketInput, claim: string): ResolverBinding {
  const binding: ResolverBinding = {
    kind: input.method,
    source: input.source,
    metric: input.metric,
    description: claim,
  };
  if (input.target !== undefined) binding.target = input.target;
  if (input.comparator !== undefined) binding.comparator = input.comparator;
  return binding;
}
