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
  sourceMetricError,
} from "@/core/resolution-recipe";
import { assessMarket } from "@/core/category-policy";
import { categoryForResolver } from "@/core/market-category";

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
/**
 * The vault's caps, mirrored (contracts/src/hunch_vault.rs: `MAX_QUESTION_LEN`,
 * `MAX_PUBLIC_FEE_BPS`, `MAX_OUTCOMES`). They MUST be enforced here: on-chain `create_market` is
 * submitted by the operator key, which is the vault ADMIN, so the contract's own public-creation
 * guardrails never run for app creations — and `MAX_QUESTION_LEN` is BYTES (Rust `str::len`),
 * where `MAX_CLAIM_CHARS` above counts UTF-16 chars. A 150-char emoji claim is ~600 bytes.
 */
const MAX_TITLE_BYTES = 200;
const MAX_FEE_BPS = 500;
const MAX_OUTCOMES = 8;

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
  // The vault checks the on-chain question in BYTES, and the question is the claim plus the "?"
  // this module appends. Reject over-byte claims before anyone pays a bond for a market the vault
  // would refuse (or, worse, that the admin key would open past the vault's own cap).
  const title = claim.endsWith("?") ? claim : `${claim}?`;
  const titleBytes = new TextEncoder().encode(title).length;
  if (titleBytes > MAX_TITLE_BYTES) {
    return {
      ok: false,
      reason: "invalid-input",
      message: `claim must fit in ${MAX_TITLE_BYTES} bytes on chain — this one is ${titleBytes} bytes once encoded (the trailing '?' counts)`,
    };
  }

  // Moderation FIRST — a prohibited claim never reaches the recipe or the LLM.
  const verdict = assessMarket(claim);
  if (!verdict.allowed) {
    return { ok: false, reason: "category", message: verdict.message ?? "market not allowed" };
  }

  // The `internal` source is the meta shelf — markets that score the platform's own agent boards,
  // resolved from state this server controls. The vault reserves the matching `meta` category to
  // the admin for exactly that reason; the human create path must refuse it too, because the
  // operator key IS the admin and would sail past the contract's check.
  if (input.source === "internal") {
    return {
      ok: false,
      reason: "invalid-input",
      message: "the 'internal' source is reserved for the platform's own meta-markets",
    };
  }

  // `attested` settles on the Arbiter's word plus a published evidence bundle rather than on a
  // datum anyone can fetch. Letting the public mint one would let a creator open a market only
  // the platform's oracle can settle — and then argue about the settlement. The curated
  // catalogue carries the one attested market there is; everything else must name a real feed.
  if (input.source === "attested") {
    return {
      ok: false,
      reason: "invalid-input",
      message: "the 'attested' source is reserved for curated markets resolved from a published announcement",
    };
  }

  // Vault cap on the fee, mirrored (the admin key skips `MAX_PUBLIC_FEE_BPS` on chain).
  if (input.feeBps !== undefined) {
    if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > MAX_FEE_BPS) {
      return {
        ok: false,
        reason: "invalid-input",
        message: `feeBps must be an integer between 0 and ${MAX_FEE_BPS}`,
      };
    }
  }

  // Outcomes, when the creator supplies them, must be the shape the vault (and the recipe) can
  // hold: 2–8 entries, each a non-empty key + label. A 1-entry array used to silently become
  // YES/NO — a market the creator did not ask for; now it is a plain rejection.
  if (input.outcomes !== undefined) {
    if (!Array.isArray(input.outcomes) || input.outcomes.length < 2 || input.outcomes.length > MAX_OUTCOMES) {
      return {
        ok: false,
        reason: "invalid-input",
        message: `outcomes must be a list of 2 to ${MAX_OUTCOMES} entries`,
      };
    }
    for (const outcome of input.outcomes) {
      if (
        typeof outcome !== "object" ||
        outcome === null ||
        typeof outcome.key !== "string" ||
        outcome.key.trim().length === 0 ||
        typeof outcome.label !== "string" ||
        outcome.label.trim().length === 0
      ) {
        return {
          ok: false,
          reason: "invalid-input",
          message: "every outcome needs a non-empty key and label",
        };
      }
    }
  }

  const outcomes = input.outcomes ?? YES_NO;
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
  // Coherence beyond internal validity: the source must actually SERVE the metric, or the market
  // composes cleanly and then sits unresolvable forever with real money in its pools.
  const incoherence = sourceMetricError(recipe.source, recipe.metric);
  if (incoherence) {
    return { ok: false, reason: "invalid-recipe", message: incoherence };
  }

  const hash = recipeHash(recipe);

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
    // Derived from the frozen recipe — a community market is filed by how it will be settled,
    // never by a hardcoded shelf. See core/market-category.
    category: categoryForResolver(recipe),
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
