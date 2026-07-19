import { describe, it, expect } from "vitest";
import {
  type ResolutionRecipe,
  RECIPE_VERSION,
  validateRecipe,
  canonicalizeRecipe,
  recipeHash,
  recipeFromBinding,
} from "@/core/resolution-recipe";
import type { ResolverBinding } from "@/core/types";

function recipe(over: Partial<ResolutionRecipe> = {}): ResolutionRecipe {
  return {
    version: RECIPE_VERSION,
    source: "coingecko",
    metric: "cspr_usd",
    method: "threshold",
    target: "0.10",
    comparator: "gte",
    resolveAtIso: "2026-12-31T00:00:00.000Z",
    outcomeKeys: ["yes", "no"],
    description: "CSPR at or above $0.10 at the snapshot.",
    ...over,
  };
}

describe("recipe validation", () => {
  it("accepts a well-formed threshold recipe", () => {
    expect(validateRecipe(recipe()).ok).toBe(true);
  });
  it("requires target + comparator for a threshold", () => {
    expect(validateRecipe(recipe({ target: undefined })).ok).toBe(false);
    expect(validateRecipe(recipe({ comparator: undefined })).ok).toBe(false);
  });
  it("requires at least two distinct valid outcome keys", () => {
    expect(validateRecipe(recipe({ outcomeKeys: ["yes"] })).ok).toBe(false);
    expect(validateRecipe(recipe({ outcomeKeys: ["yes", "yes"] })).ok).toBe(false);
    expect(validateRecipe(recipe({ outcomeKeys: ["yes", "NO"] })).ok).toBe(false); // uppercase invalid
  });
  it("forces coin_flip to read drand", () => {
    expect(validateRecipe(recipe({ method: "coin_flip", source: "coingecko", target: undefined, comparator: undefined })).ok).toBe(false);
    expect(
      validateRecipe(recipe({ method: "coin_flip", source: "drand", target: undefined, comparator: undefined, outcomeKeys: ["heads", "tails"] })).ok,
    ).toBe(true);
  });
  it("rejects an unparseable resolve time", () => {
    expect(validateRecipe(recipe({ resolveAtIso: "not-a-date" })).ok).toBe(false);
  });
});

describe("canonical hash — semantically equal ⇒ equal", () => {
  it("is independent of field insertion order", () => {
    const a = recipe();
    // Build an object with a totally different key order.
    const b: ResolutionRecipe = {
      description: a.description,
      outcomeKeys: ["yes", "no"],
      resolveAtIso: a.resolveAtIso,
      comparator: "gte",
      target: "0.10",
      method: "threshold",
      metric: "cspr_usd",
      source: "coingecko",
      version: RECIPE_VERSION,
    };
    expect(canonicalizeRecipe(a)).toBe(canonicalizeRecipe(b));
    expect(recipeHash(a)).toBe(recipeHash(b));
  });

  it("omitting an undefined optional equals not providing it", () => {
    const withUndef = recipe({ method: "direction", target: undefined, comparator: undefined });
    const clean: ResolutionRecipe = {
      version: RECIPE_VERSION,
      source: "coingecko",
      metric: "cspr_usd",
      method: "direction",
      resolveAtIso: "2026-12-31T00:00:00.000Z",
      outcomeKeys: ["yes", "no"],
      description: "CSPR at or above $0.10 at the snapshot.",
    };
    expect(recipeHash(withUndef)).toBe(recipeHash(clean));
  });

  it("NFC normalisation makes canonically-equal strings hash equal (on a hashed field)", () => {
    // Build NFD vs NFC explicitly so the test does not depend on this file's byte encoding.
    const nfd = "caf" + "e\u0301" + "_index"; // e + combining acute accent (NFD)
    const nfc = nfd.normalize("NFC"); // precomposed
    expect(nfc).not.toBe(nfd); // genuinely different byte sequences
    expect(recipeHash(recipe({ metric: nfc }))).toBe(recipeHash(recipe({ metric: nfd })));
  });

  it("is self-describing (sha256: prefix) and 64 hex chars", () => {
    const h = recipeHash(recipe());
    expect(h.startsWith("sha256:")).toBe(true);
    expect(h.slice(7)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonical hash — any material change changes the hash", () => {
  const base = recipe();
  const baseHash = recipeHash(base);
  const mutations: Array<[string, ResolutionRecipe]> = [
    ["target", recipe({ target: "0.11" })],
    ["comparator", recipe({ comparator: "lte" })],
    ["metric", recipe({ metric: "cspr_eur" })],
    ["source", recipe({ source: "cspr_cloud" })],
    ["method", recipe({ method: "direction" })],
    ["resolveAt", recipe({ resolveAtIso: "2027-01-01T00:00:00.000Z" })],
    ["outcome order", recipe({ outcomeKeys: ["no", "yes"] })],
  ];
  it.each(mutations)("changing %s changes the hash", (_label, mutated) => {
    expect(recipeHash(mutated)).not.toBe(baseHash);
  });

  it("changing ONLY the advisory description does NOT change the hash", () => {
    expect(recipeHash(recipe({ description: "totally different wording, same rule" }))).toBe(baseHash);
  });
});

describe("recipeFromBinding bridges the existing catalogue", () => {
  it("builds a valid recipe from a ResolverBinding + outcomes + deadline", () => {
    const binding: ResolverBinding = {
      kind: "threshold",
      source: "coingecko",
      metric: "cspr_usd",
      target: "0.05",
      comparator: "gte",
      description: "CSPR ≥ $0.05",
    };
    const r = recipeFromBinding(binding, ["yes", "no"], "2026-08-01T00:00:00.000Z");
    expect(validateRecipe(r).ok).toBe(true);
    expect(r.target).toBe("0.05");
  });

  it("omits target/comparator when the binding has none", () => {
    const binding: ResolverBinding = { kind: "coin_flip", source: "drand", metric: "beacon", description: "flip" };
    const r = recipeFromBinding(binding, ["heads", "tails"], "2026-08-01T00:00:00.000Z");
    expect(r.target).toBeUndefined();
    expect(r.comparator).toBeUndefined();
  });
});
