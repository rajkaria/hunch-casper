import { describe, it, expect } from "vitest";
import { replayRecipe, snapshotForOutcome, verifyResolution } from "@/core/resolution-replay";
import { type ResolutionRecipe, RECIPE_VERSION, recipeHash } from "@/core/resolution-recipe";
import { type EvidenceBundle, bundleHash } from "@/core/evidence-bundle";

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
    description: "CSPR ≥ $0.10",
    ...over,
  };
}

describe("replayRecipe — deterministic re-execution", () => {
  it("threshold gte: at/above target → affirmative, below → negative", () => {
    expect(replayRecipe(recipe(), { cspr_usd: "0.10" })).toEqual({ decided: true, winningOutcomeKey: "yes" });
    expect(replayRecipe(recipe(), { cspr_usd: "0.15" })).toEqual({ decided: true, winningOutcomeKey: "yes" });
    expect(replayRecipe(recipe(), { cspr_usd: "0.09" })).toEqual({ decided: true, winningOutcomeKey: "no" });
  });

  it("threshold lte mirrors", () => {
    const r = recipe({ comparator: "lte" });
    expect(replayRecipe(r, { cspr_usd: "0.10" }).decided && replayRecipe(r, { cspr_usd: "0.10" })).toMatchObject({ winningOutcomeKey: "yes" });
    expect(replayRecipe(r, { cspr_usd: "0.20" })).toMatchObject({ winningOutcomeKey: "no" });
  });

  it("direction: sign of the delta, zero voids", () => {
    const r = recipe({ method: "direction", target: undefined, comparator: undefined, outcomeKeys: ["up", "down"] });
    expect(replayRecipe(r, { cspr_usd: "3" })).toEqual({ decided: true, winningOutcomeKey: "up" });
    expect(replayRecipe(r, { cspr_usd: "-2" })).toEqual({ decided: true, winningOutcomeKey: "down" });
    expect(replayRecipe(r, { cspr_usd: "0" })).toEqual({ decided: true, winningOutcomeKey: null });
  });

  it("nway/coin_flip/agent_metric: snapshot names the winner directly", () => {
    const r = recipe({ method: "coin_flip", source: "drand", target: undefined, comparator: undefined, metric: "beacon", outcomeKeys: ["heads", "tails"] });
    expect(replayRecipe(r, { beacon: "heads" })).toEqual({ decided: true, winningOutcomeKey: "heads" });
    expect(replayRecipe(r, { beacon: "__void__" })).toEqual({ decided: true, winningOutcomeKey: null });
    expect(replayRecipe(r, { beacon: "sideways" }).decided).toBe(false);
  });

  it("is not decided when the snapshot lacks the datum", () => {
    expect(replayRecipe(recipe(), {}).decided).toBe(false);
  });
});

describe("snapshotForOutcome is the inverse of replayRecipe", () => {
  const cases: ResolutionRecipe[] = [
    recipe(),
    recipe({ comparator: "lte" }),
    recipe({ method: "direction", target: undefined, comparator: undefined, outcomeKeys: ["up", "down"] }),
    recipe({ method: "nway_winner", metric: "winner", target: undefined, comparator: undefined, outcomeKeys: ["a", "b", "c"] }),
    recipe({ method: "coin_flip", source: "drand", metric: "beacon", target: undefined, comparator: undefined, outcomeKeys: ["heads", "tails"] }),
  ];
  it("round-trips every outcome key back to itself", () => {
    for (const r of cases) {
      for (const key of r.outcomeKeys) {
        const snap = snapshotForOutcome(r, key);
        expect(replayRecipe(r, snap)).toEqual({ decided: true, winningOutcomeKey: key });
      }
    }
  });
});

describe("verifyResolution — the CI replay harness over fixtures", () => {
  // Each fixture: a recipe, an outcome, and the bundle the Arbiter would publish. CI re-derives the
  // winner from the bundle's snapshot and confirms it bit-for-bit.
  const fixtures = [
    { recipe: recipe(), outcome: "yes" as const },
    { recipe: recipe({ comparator: "lte", target: "0.05" }), outcome: "no" as const },
    { recipe: recipe({ method: "direction", target: undefined, comparator: undefined, outcomeKeys: ["up", "down"] }), outcome: "down" as const },
  ];

  it.each(fixtures)("reproduces fixture resolution %#", ({ recipe: r, outcome }) => {
    const snapshot = snapshotForOutcome(r, outcome);
    const b: EvidenceBundle = {
      version: 1,
      marketId: "testnet:m",
      recipeHash: recipeHash(r),
      winningOutcomeKey: outcome,
      resolvedAtIso: "2026-08-01T00:00:00.000Z",
      sources: [{ source: r.source, metric: r.metric, reference: r.description }],
      snapshot,
      reasoning: "fixture",
    };
    const v = verifyResolution(r, b, bundleHash(b));
    expect(v.ok).toBe(true);
    expect(v.recipeHashMatches).toBe(true);
    expect(v.bundleHashMatches).toBe(true);
    expect(v.outcomeMatches).toBe(true);
  });

  it("flags drift when the recorded winner disagrees with the replay", () => {
    const r = recipe();
    const b: EvidenceBundle = {
      version: 1,
      marketId: "testnet:m",
      recipeHash: recipeHash(r),
      winningOutcomeKey: "no", // WRONG — snapshot says yes
      resolvedAtIso: "2026-08-01T00:00:00.000Z",
      sources: [],
      snapshot: { cspr_usd: "0.20" },
      reasoning: "tampered",
    };
    const v = verifyResolution(r, b, bundleHash(b));
    expect(v.ok).toBe(false);
    expect(v.outcomeMatches).toBe(false);
  });

  it("flags a tampered bundle hash", () => {
    const r = recipe();
    const snapshot = snapshotForOutcome(r, "yes");
    const b: EvidenceBundle = {
      version: 1,
      marketId: "testnet:m",
      recipeHash: recipeHash(r),
      winningOutcomeKey: "yes",
      resolvedAtIso: "2026-08-01T00:00:00.000Z",
      sources: [],
      snapshot,
      reasoning: "ok",
    };
    const v = verifyResolution(r, b, "sha256:not-the-real-hash");
    expect(v.ok).toBe(false);
    expect(v.bundleHashMatches).toBe(false);
  });
});
