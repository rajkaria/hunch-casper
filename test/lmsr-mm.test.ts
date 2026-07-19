import { describe, it, expect } from "vitest";
import { maxLiquidityParam, withinExposureCap, vetTrade } from "@/core/lmsr-risk";
import { lmsrBoundedLoss, lmsrPrices, lmsrApply, type LmsrState } from "@/core/lmsr";
import {
  emptyLpVault,
  deposit,
  withdraw,
  accrueFees,
  lpValue,
  sharesForDeposit,
} from "@/core/lp-vault";
import { makerQuotes, makerEdgeCaptured } from "@/core/mm-strategy";

describe("LMSR risk controls", () => {
  it("maxLiquidityParam gives a b whose worst-case loss equals the budget", () => {
    const b = maxLiquidityParam(1000, 2);
    expect(lmsrBoundedLoss(b, 2)).toBeCloseTo(1000, 6);
  });

  it("exposure cap accepts a within-budget book and rejects an over-budget one", () => {
    const config = { maxSubsidy: 100, maxPriceMovePerTrade: 1 };
    expect(withinExposureCap({ b: 50, q: [0, 0] }, config)).toBe(true); // 50·ln2 ≈ 34.7 ≤ 100
    expect(withinExposureCap({ b: 100, q: [0, 0] }, config)).toBe(true); // 100·ln2 ≈ 69.3 ≤ 100
    expect(withinExposureCap({ b: 200, q: [0, 0] }, config)).toBe(false); // 200·ln2 ≈ 138.6 > 100
  });

  it("circuit breaker refuses a trade that moves a price too far", () => {
    const s: LmsrState = { b: 30, q: [0, 0] };
    // A huge buy on a shallow book moves the price a lot → breaker trips.
    const big = vetTrade(s, 0, 200, { maxSubsidy: 1e9, maxPriceMovePerTrade: 0.2 });
    expect(big.ok).toBe(false);
    expect(big.reason).toBe("circuit-breaker");
    // A tiny buy is fine.
    const small = vetTrade(s, 0, 1, { maxSubsidy: 1e9, maxPriceMovePerTrade: 0.2 });
    expect(small.ok).toBe(true);
  });
});

describe("LP vault share accounting", () => {
  it("first deposit mints 1:1, later deposits mint pro-rata", () => {
    let v = emptyLpVault();
    ({ state: v } = deposit(v, "alice", "1000"));
    expect(v.totalShares).toBe("1000");
    expect(lpValue(v, "alice")).toBe("1000");
    // Bob deposits into a pool of the same value → same share ratio.
    ({ state: v } = deposit(v, "bob", "500"));
    expect(sharesForDeposit(v, "1")).toBeDefined();
    expect(lpValue(v, "bob")).toBe("500");
    expect(lpValue(v, "alice")).toBe("1000");
  });

  it("accrued fees appreciate every LP's shares pro-rata, no new shares minted", () => {
    let v = emptyLpVault();
    ({ state: v } = deposit(v, "alice", "600"));
    ({ state: v } = deposit(v, "bob", "400")); // 60/40 split of 1000
    const sharesBefore = v.totalShares;
    v = accrueFees(v, "100"); // pool now 1100, shares unchanged
    expect(v.totalShares).toBe(sharesBefore);
    // Alice (60%) gets 660, Bob (40%) 440.
    expect(lpValue(v, "alice")).toBe("660");
    expect(lpValue(v, "bob")).toBe("440");
  });

  it("withdrawal burns shares for pool value and conserves the pool", () => {
    let v = emptyLpVault();
    ({ state: v } = deposit(v, "alice", "1000"));
    v = accrueFees(v, "200"); // pool 1200
    let motesOut = "";
    ({ state: v, motesOut } = withdraw(v, "alice", "500")); // half her shares
    expect(motesOut).toBe("600"); // half of 1200
    expect(v.poolValueMotes).toBe("600");
    expect(v.totalShares).toBe("500");
  });

  it("rejects over-withdrawal and non-positive amounts", () => {
    let v = emptyLpVault();
    ({ state: v } = deposit(v, "alice", "100"));
    expect(() => withdraw(v, "alice", "200")).toThrow(/insufficient/);
    expect(() => deposit(v, "x", "0")).toThrow();
  });
});

describe("agent market-maker quotes", () => {
  it("buys an under-priced outcome and sells an over-priced one, toward belief", () => {
    const state: LmsrState = { b: 200, q: [0, 0] }; // book prices 50/50
    const belief = [0.7, 0.3]; // maker thinks outcome 0 is under-priced
    const quotes = makerQuotes(state, belief);
    const q0 = quotes.find((q) => q.outcome === 0);
    expect(q0).toBeDefined();
    expect(q0!.delta).toBeGreaterThan(0); // buy the under-priced side
  });

  it("stays quiet when the book already matches belief (no edge)", () => {
    const state: LmsrState = { b: 200, q: [0, 0] };
    expect(makerQuotes(state, [0.5, 0.5])).toHaveLength(0);
  });

  it("respects the circuit breaker (never proposes a trade that would trip it)", () => {
    const state: LmsrState = { b: 20, q: [0, 0] }; // very shallow
    const quotes = makerQuotes(state, [0.95, 0.05], { minEdge: 0.03, sizePerEdge: 5000, risk: { maxSubsidy: 1e9, maxPriceMovePerTrade: 0.1 } });
    for (const q of quotes) {
      const vet = vetTrade(state, q.outcome, q.delta, { maxSubsidy: 1e9, maxPriceMovePerTrade: 0.1 });
      expect(vet.ok).toBe(true);
    }
  });

  it("quoting continuously drives the book toward the maker's belief (flagship end-to-end)", () => {
    let state: LmsrState = { b: 300, q: [0, 0] };
    const belief = [0.75, 0.25];
    const risk = { maxSubsidy: 1e9, maxPriceMovePerTrade: 0.2 };
    // Run the maker for several rounds; each round it re-quotes against the fresh book.
    for (let round = 0; round < 40; round++) {
      const quotes = makerQuotes(state, belief, { minEdge: 0.01, sizePerEdge: 100, risk });
      if (quotes.length === 0) break;
      for (const q of quotes) state = lmsrApply(state, q.outcome, q.delta);
    }
    // The book price for outcome 0 has converged near the maker's belief.
    const p = lmsrPrices(state);
    expect(Math.abs(p[0] - belief[0])).toBeLessThan(0.05);
  });

  it("scores captured edge for the MM track record", () => {
    const quotes = [
      { outcome: 0, delta: 100, bookPrice: 0.5, belief: 0.7 },
      { outcome: 1, delta: -50, bookPrice: 0.5, belief: 0.3 },
    ];
    // 0.2*100 + 0.2*50 = 30
    expect(makerEdgeCaptured(quotes)).toBeCloseTo(30, 9);
  });
});
