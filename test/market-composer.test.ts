import { describe, it, expect } from "vitest";
import { composeMarket, findDuplicate, normalizeTitle } from "@/core/market-composer";
import type { ComposeMarketInput } from "@/core/market-composer";
import { createMockLlm } from "@/adapters/mock/mock-llm";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { recipeFromBinding, recipeHash } from "@/core/resolution-recipe";

const llm = createMockLlm();

function input(over: Partial<ComposeMarketInput> = {}): ComposeMarketInput {
  return {
    claim: "Will CSPR cross $0.10 by year end",
    creator: "creator-1",
    network: "testnet",
    seq: 0,
    deadlineIso: "2026-12-31T00:00:00.000Z",
    source: "coingecko",
    metric: "cspr_usd",
    method: "threshold",
    target: "0.10",
    comparator: "gte",
    ...over,
  };
}

describe("composeMarket", () => {
  it("composes a valid market with a recipe hash and YES/NO default outcomes", async () => {
    const res = await composeMarket(input(), { llm, existing: [] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.definition.outcomes.map((o) => o.key)).toEqual(["yes", "no"]);
      expect(res.definition.title.endsWith("?")).toBe(true);
      expect(res.recipeHash.startsWith("sha256:")).toBe(true);
      expect(res.definition.category).toBe("provably-fair");
      expect(res.definition.slug).toContain("user-");
    }
  });

  it("rejects a claim the category policy forbids (422 reason)", async () => {
    const res = await composeMarket(input({ claim: "Will the mayor be assassinated this year" }), { llm, existing: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("category");
  });

  it("rejects an invalid recipe (threshold without a target)", async () => {
    const res = await composeMarket(input({ target: undefined }), { llm, existing: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid-recipe");
  });

  it("rejects an empty or over-long claim", async () => {
    expect((await composeMarket(input({ claim: "  " }), { llm, existing: [] })).ok).toBe(false);
    expect((await composeMarket(input({ claim: "x".repeat(300) }), { llm, existing: [] })).ok).toBe(false);
  });

  it("detects a duplicate by recipe hash against the shipped catalogue", async () => {
    const catalogueDef = MARKET_DEFINITIONS.find((d) => d.slug === "cspr-price-05-aug")!;
    // Compose a market whose rule matches the catalogue market's binding exactly.
    const res = await composeMarket(
      input({
        claim: "A different question entirely, same rule",
        source: catalogueDef.resolver.source,
        metric: catalogueDef.resolver.metric,
        method: catalogueDef.resolver.kind,
        target: catalogueDef.resolver.target,
        comparator: catalogueDef.resolver.comparator,
        deadlineIso: catalogueDef.deadlineIso,
      }),
      { llm, existing: [...MARKET_DEFINITIONS] },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("duplicate");
  });

  it("detects a duplicate by normalized title", async () => {
    const first = await composeMarket(input({ seq: 1 }), { llm, existing: [] });
    expect(first.ok).toBe(true);
    if (first.ok) {
      const dup = await composeMarket(input({ seq: 2, metric: "cspr_eur" }), { llm, existing: [first.definition] });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.reason).toBe("duplicate");
    }
  });
});

describe("findDuplicate / normalizeTitle", () => {
  it("normalizes punctuation and case", () => {
    expect(normalizeTitle("Will CSPR cross $0.10?")).toBe(normalizeTitle("will cspr cross 0 10"));
  });

  it("returns null when nothing matches", () => {
    const r = recipeFromBinding(
      { kind: "threshold", source: "coingecko", metric: "btc_usd", target: "1", comparator: "gte", description: "x" },
      ["yes", "no"],
      "2026-12-31T00:00:00.000Z",
    );
    expect(findDuplicate({ recipeHash: recipeHash(r), title: "totally unique question" }, [...MARKET_DEFINITIONS])).toBeNull();
  });
});
