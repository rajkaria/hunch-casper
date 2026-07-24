import { describe, expect, it, vi, afterEach } from "vitest";
import { createMockChain } from "@/adapters/mock/mock-chain";
import { resolveMarket } from "@/agent/arbiter";
import { createContainer } from "@/lib/container";
import { buildCommitRecipePlan, buildCommitBundlePlan } from "@/adapters/casper/deploy-plan";

afterEach(() => vi.unstubAllEnvs());

describe("anchorResolution — the port contract", () => {
  it("the mock adapter anchors deterministically", async () => {
    const chain = createMockChain("testnet");
    const a = await chain.anchorResolution({ marketId: "m", recipeHash: "r", bundleHash: "b" });
    const b = await chain.anchorResolution({ marketId: "m", recipeHash: "r", bundleHash: "b" });
    expect(a.recipeDeployHash).toBe(b.recipeDeployHash);
    expect(a.bundleDeployHash).toBeTruthy();
    expect(a.skipped).toBeUndefined();
  });

  it("different hashes anchor to different transactions", async () => {
    const chain = createMockChain("testnet");
    const a = await chain.anchorResolution({ marketId: "m", recipeHash: "r1", bundleHash: "b" });
    const b = await chain.anchorResolution({ marketId: "m", recipeHash: "r2", bundleHash: "b" });
    expect(a.recipeDeployHash).not.toBe(b.recipeDeployHash);
  });
});

describe("commit plans target only the v2 vault", () => {
  it("builds a commit_recipe call against a vault market", () => {
    const plan = buildCommitRecipePlan("slug", "abc", {
      marketContract: "hash-" + "a".repeat(64),
      vaultMarketId: "slug",
    });
    expect(plan.entryPoint).toBe("commit_recipe");
    expect(plan.attachedMotes).toBe("0");
    expect(plan.usesProxy).toBe(false);
    expect(plan.args.some((a) => a.name === "recipe_hash")).toBe(true);
  });

  it("builds a commit_bundle call against a vault market", () => {
    const plan = buildCommitBundlePlan("slug", "def", {
      marketContract: "hash-" + "a".repeat(64),
      vaultMarketId: "slug",
    });
    expect(plan.entryPoint).toBe("commit_bundle");
    expect(plan.args.some((a) => a.name === "bundle_hash")).toBe(true);
  });

  it("refuses a v1 target, which has no commit entrypoint", () => {
    // Calling it there would burn gas on a guaranteed revert.
    expect(() =>
      buildCommitRecipePlan("slug", "abc", { marketContract: "hash-" + "a".repeat(64) }),
    ).toThrow();
  });

  it("refuses an empty hash rather than anchoring nothing", () => {
    expect(() =>
      buildCommitRecipePlan("slug", "", { marketContract: "hash-" + "a".repeat(64), vaultMarketId: "s" }),
    ).toThrow();
  });
});

describe("anchoring never blocks a payout", () => {
  it("a resolution still settles when anchoring throws", async () => {
    const container = createContainer("testnet");
    const chain = {
      ...container.chain,
      anchorResolution: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    };
    // Winners have already been paid by the time anchoring runs; letting a metadata write abort
    // that would strand user money to protect a hash.
    const open = await container.store.list({ network: "testnet", status: "open" });
    const target = open.find((m) => m.category !== "meta");
    expect(target).toBeDefined();
    await expect(
      resolveMarket({ ...container, chain } as never, target!.slug),
    ).resolves.not.toThrow();
  });
});
