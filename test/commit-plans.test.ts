import { describe, it, expect } from "vitest";
import { buildCommitRecipePlan, buildCommitBundlePlan } from "@/adapters/casper/deploy-plan";

const MARKET = "hash-vault";
const OPTS = { marketContract: MARKET, vaultMarketId: "cspr-price-05-aug" };

describe("S24 commit deploy plans", () => {
  it("builds a commit_recipe plan with the v2 (market_id, recipe_hash) ABI", () => {
    const plan = buildCommitRecipePlan("cspr-price-05-aug", "sha256:abc", OPTS);
    expect(plan.entryPoint).toBe("commit_recipe");
    expect(plan.usesProxy).toBe(false);
    expect(plan.attachedMotes).toBe("0");
    expect(plan.args.map((a) => a.name)).toEqual(["market_id", "recipe_hash"]);
    const recipeArg = plan.args.find((a) => a.name === "recipe_hash");
    expect(recipeArg).toMatchObject({ clType: "string", value: "sha256:abc" });
  });

  it("builds a commit_bundle plan with the v2 (market_id, bundle_hash) ABI", () => {
    const plan = buildCommitBundlePlan("cspr-price-05-aug", "sha256:def", OPTS);
    expect(plan.entryPoint).toBe("commit_bundle");
    expect(plan.args.map((a) => a.name)).toEqual(["market_id", "bundle_hash"]);
  });

  it("requires a v2 vault target and a non-empty hash", () => {
    expect(() => buildCommitRecipePlan("m", "sha256:abc", { marketContract: MARKET })).toThrow(/HunchVault v2/);
    expect(() => buildCommitRecipePlan("m", "", OPTS)).toThrow(/recipeHash/);
    expect(() => buildCommitBundlePlan("m", "", OPTS)).toThrow(/bundleHash/);
  });
});
