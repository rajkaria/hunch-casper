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
      // A CSPR price market from CoinGecko is Casper-native. The category is derived from the
      // resolver, never stamped — see test/market-category-from-resolver.test.ts.
      expect(res.definition.category).toBe("casper-native");
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

/**
 * The vault's own caps, enforced app-side — because on this deployment `create_market` is
 * submitted by the operator key, which is the vault ADMIN, so the contract's public-creation
 * checks (question bytes, fee cap, outcome count, reserved meta category) never run.
 */
describe("vault caps mirrored in the composer", () => {
  it("rejects a claim over 200 BYTES even when under 200 chars", async () => {
    const claim = "é".repeat(150); // 150 chars — but 301 bytes once encoded with the appended '?'
    const res = await composeMarket(input({ claim }), { llm, existing: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("invalid-input");
      expect(res.message).toMatch(/bytes/);
    }
  });

  it("accepts an ASCII claim that sits exactly on the byte cap", async () => {
    const claim = "Will CSPR do this thing".padEnd(199, "x"); // + '?' = 200 bytes
    const res = await composeMarket(input({ claim }), { llm, existing: [] });
    expect(res.ok).toBe(true);
  });

  it("rejects a feeBps outside 0..500 or non-integer", async () => {
    for (const feeBps of [501, -1, 2.5, Number.NaN]) {
      const res = await composeMarket(input({ feeBps }), { llm, existing: [] });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("invalid-input");
    }
  });

  it("accepts the fee cap itself and zero", async () => {
    expect((await composeMarket(input({ feeBps: 500 }), { llm, existing: [] })).ok).toBe(true);
    expect((await composeMarket(input({ feeBps: 0 }), { llm, existing: [] })).ok).toBe(true);
  });

  it("rejects supplied outcomes outside 2..8 or with empty fields", async () => {
    const one = [{ key: "yes", label: "Yes" }];
    const nine = Array.from({ length: 9 }, (_, i) => ({ key: `o${i}`, label: `O${i}` }));
    const emptyLabel = [
      { key: "yes", label: "Yes" },
      { key: "no", label: "" },
    ];
    for (const outcomes of [one, nine, emptyLabel]) {
      const res = await composeMarket(input({ outcomes }), { llm, existing: [] });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe("invalid-input");
    }
  });

  it("accepts a well-formed multi-outcome set", async () => {
    const outcomes = [
      { key: "alpha", label: "Alpha" },
      { key: "beta", label: "Beta" },
      { key: "gamma", label: "Gamma" },
    ];
    const res = await composeMarket(
      input({ method: "nway_winner", target: undefined, comparator: undefined, outcomes }),
      { llm, existing: [] },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.definition.outcomes.map((o) => o.key)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("refuses the internal (meta) source on the human path", async () => {
    const res = await composeMarket(
      input({ source: "internal", metric: "prophet_pnl", method: "agent_metric", target: undefined, comparator: undefined }),
      { llm, existing: [] },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("invalid-input");
      expect(res.message).toMatch(/reserved/);
    }
  });
});

describe("source/metric coherence — no unresolvable markets", () => {
  it("rejects a metric the source does not serve", async () => {
    const res = await composeMarket(input({ metric: "banana" }), { llm, existing: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("invalid-recipe");
      expect(res.message).toMatch(/cannot resolve/);
    }
  });

  it("rejects a real metric paired with the wrong source", async () => {
    const res = await composeMarket(input({ source: "cspr_cloud", metric: "cspr_usd" }), { llm, existing: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid-recipe");
  });

  it("accepts each public source with a metric it actually serves", async () => {
    const pairs = [
      { claim: "Will BTC cross $100k by year end", source: "coingecko", metric: "btc_usd", target: "100000" },
      { claim: "Will daily deploys cross 30k by year end", source: "cspr_cloud", metric: "daily_deploys", target: "30000" },
      { claim: "Will gold cross $2500 by year end", source: "macro_feed", metric: "gold_usd_oz", target: "2500" },
    ] as const;
    for (const p of pairs) {
      const res = await composeMarket(input({ ...p }), { llm, existing: [] });
      expect(res.ok).toBe(true);
    }
    const flip = await composeMarket(
      input({
        claim: "Heads or tails at the stroke of midnight",
        source: "drand",
        metric: "drand_parity",
        method: "coin_flip",
        target: undefined,
        comparator: undefined,
        outcomes: [
          { key: "heads", label: "Heads" },
          { key: "tails", label: "Tails" },
        ],
      }),
      { llm, existing: [] },
    );
    expect(flip.ok).toBe(true);
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
