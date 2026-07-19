import { describe, it, expect } from "vitest";
import {
  lmsrCost,
  lmsrPrices,
  lmsrTradeCost,
  lmsrApply,
  lmsrBoundedLoss,
  lmsrMakerPnlIfWins,
  type LmsrState,
} from "@/core/lmsr";

const EPS = 1e-9;

function uniform(b: number, n: number): LmsrState {
  return { b, q: Array.from({ length: n }, () => 0) };
}

describe("LMSR invariants", () => {
  it("prices form a probability distribution (sum to 1, each in [0,1])", () => {
    const states: LmsrState[] = [
      uniform(100, 2),
      { b: 100, q: [50, 10] },
      { b: 50, q: [0, 20, 5] },
      { b: 200, q: [300, -100, 40, 12] },
    ];
    for (const s of states) {
      const p = lmsrPrices(s);
      const sum = p.reduce((a, c) => a + c, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(EPS);
      for (const pi of p) {
        expect(pi).toBeGreaterThanOrEqual(0);
        expect(pi).toBeLessThanOrEqual(1);
      }
    }
  });

  it("a uniform book prices every outcome equally at 1/n", () => {
    const p = lmsrPrices(uniform(100, 4));
    for (const pi of p) expect(Math.abs(pi - 0.25)).toBeLessThan(EPS);
  });

  it("buying an outcome raises its price and lowers the others (monotone impact)", () => {
    const s = uniform(100, 3);
    const before = lmsrPrices(s);
    const after = lmsrPrices(lmsrApply(s, 0, 40));
    expect(after[0]).toBeGreaterThan(before[0]);
    expect(after[1]).toBeLessThan(before[1]);
    expect(after[2]).toBeLessThan(before[2]);
  });

  it("cost is strictly increasing when you buy (you always pay a positive amount)", () => {
    const s = { b: 100, q: [10, 5] };
    expect(lmsrTradeCost(s, 0, 25)).toBeGreaterThan(0);
    // And the marginal price is between 0 and 1 per share.
    const perShare = lmsrTradeCost(s, 0, 1);
    expect(perShare).toBeGreaterThan(0);
    expect(perShare).toBeLessThan(1);
  });

  it("no free money: buy then immediately sell the same delta nets to zero", () => {
    const s = { b: 100, q: [20, 5, 8] };
    const buy = lmsrTradeCost(s, 1, 30);
    const afterBuy = lmsrApply(s, 1, 30);
    const sell = lmsrTradeCost(afterBuy, 1, -30); // proceeds are negative cost
    expect(Math.abs(buy + sell)).toBeLessThan(1e-6);
    // The round trip never yields a profit.
    expect(buy + sell).toBeLessThanOrEqual(EPS);
  });

  it("bounded loss: the maker is never down more than b·ln(n), for any state and winner", () => {
    const cases: LmsrState[] = [
      { b: 100, q: [500, 0] },
      { b: 100, q: [0, 500] },
      { b: 50, q: [300, 100, 0] },
      { b: 200, q: [1000, -50, 20, 5] },
      uniform(100, 5),
    ];
    for (const s of cases) {
      const bound = lmsrBoundedLoss(s.b, s.q.length);
      for (let i = 0; i < s.q.length; i++) {
        const pnl = lmsrMakerPnlIfWins(s, i);
        // Loss (−pnl) cannot exceed the bound (allow a hair of float slack).
        expect(-pnl).toBeLessThanOrEqual(bound + 1e-6);
      }
    }
  });

  it("cost matches C(q) = b·ln(Σ exp(q_i/b)) for a hand vector", () => {
    // b=1, q=[0,0]: C = ln(2) ≈ 0.6931471805599453
    expect(lmsrCost({ b: 1, q: [0, 0] })).toBeCloseTo(Math.log(2), 12);
    // b=2, q=[2,0]: C = 2·ln(e^1 + e^0) = 2·ln(e+1) ≈ 2·1.3132616875 = 2.626523375
    expect(lmsrCost({ b: 2, q: [2, 0] })).toBeCloseTo(2 * Math.log(Math.E + 1), 12);
  });

  it("bounded loss equals b·ln(n)", () => {
    expect(lmsrBoundedLoss(100, 2)).toBeCloseTo(100 * Math.log(2), 12);
    expect(lmsrBoundedLoss(50, 4)).toBeCloseTo(50 * Math.log(4), 12);
  });

  it("rejects invalid books", () => {
    expect(() => lmsrCost({ b: 0, q: [1, 1] })).toThrow();
    expect(() => lmsrCost({ b: 10, q: [1] })).toThrow();
    expect(() => lmsrTradeCost({ b: 10, q: [1, 1] }, 5, 1)).toThrow();
  });
});
