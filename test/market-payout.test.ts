import { describe, it, expect } from "vitest";
import { computeMarketPayouts, previewPayoutMotes } from "@/core/market-payout";
import type { PayoutInput } from "@/core/market-payout";

const YES_NO = ["yes", "no"];

/**
 * Parity vectors ported verbatim from the on-chain vault's OdraVM tests
 * (contracts/src/parimutuel_market.rs). If the TS engine and the Rust engine ever disagree on
 * these, one of them is wrong — that is the whole point of this suite.
 */
describe("computeMarketPayouts — on-chain parity vectors", () => {
  it("two-sided resolve pays winners and sweeps fee from the losing pool (100 YES vs 300 NO @ 2%)", () => {
    const input: PayoutInput = {
      outcomeKeys: YES_NO,
      poolByOutcomeMotes: { yes: "100", no: "300" },
      stakesByBettor: { alice: { yes: "100" }, bob: { no: "300" } },
      feeBps: 200,
      winningOutcomeKey: "yes",
    };
    const m = computeMarketPayouts(input);
    expect(m.mode).toBe("resolved");
    expect(m.feeMotes).toBe("6"); // floor(300 * 200 / 10000)
    expect(m.distributableLosingMotes).toBe("294");
    expect(m.payouts.alice).toBe("394"); // 100 + 100*294/100
    expect(m.payouts.bob).toBeUndefined(); // loser
    expect(m.dustMotes).toBe("0");
  });

  it("single participant refunds full gross, no fee (100 YES @ 5%)", () => {
    const m = computeMarketPayouts({
      outcomeKeys: YES_NO,
      poolByOutcomeMotes: { yes: "100", no: "0" },
      stakesByBettor: { alice: { yes: "100" } },
      feeBps: 500,
      winningOutcomeKey: "yes",
    });
    expect(m.feeMotes).toBe("0");
    expect(m.payouts.alice).toBe("100");
    expect(m.dustMotes).toBe("0");
  });

  it("no winner auto-voids and refunds everyone (100 NO, resolve YES)", () => {
    const m = computeMarketPayouts({
      outcomeKeys: YES_NO,
      poolByOutcomeMotes: { yes: "0", no: "100" },
      stakesByBettor: { alice: { no: "100" } },
      feeBps: 200,
      winningOutcomeKey: "yes",
    });
    expect(m.mode).toBe("void");
    expect(m.feeMotes).toBe("0");
    expect(m.payouts.alice).toBe("100");
  });

  it("explicit void refunds all sides (100 YES + 300 NO)", () => {
    const m = computeMarketPayouts({
      outcomeKeys: YES_NO,
      poolByOutcomeMotes: { yes: "100", no: "300" },
      stakesByBettor: { alice: { yes: "100" }, bob: { no: "300" } },
      feeBps: 200,
      winningOutcomeKey: null,
    });
    expect(m.mode).toBe("void");
    expect(m.payouts.alice).toBe("100");
    expect(m.payouts.bob).toBe("300");
    expect(m.dustMotes).toBe("0");
  });

  it("all on the winning side get stake back, no fee (100 + 50 YES @ 3%)", () => {
    const m = computeMarketPayouts({
      outcomeKeys: YES_NO,
      poolByOutcomeMotes: { yes: "150", no: "0" },
      stakesByBettor: { alice: { yes: "100" }, bob: { yes: "50" } },
      feeBps: 300,
      winningOutcomeKey: "yes",
    });
    expect(m.feeMotes).toBe("0");
    expect(m.payouts.alice).toBe("100");
    expect(m.payouts.bob).toBe("50");
  });

  it("settles a house-seeded market exactly as the vault would given the same escrowed bets", () => {
    // House launch liquidity (yes 1200e9 / no 800e9) + Alice stakes 100 on yes, resolves yes.
    // This is the scenario the S5 review used: the engine must match the on-chain claim() given
    // these same on-chain stakes (the house is a real staker, seeded on-chain at deploy).
    const m = computeMarketPayouts({
      outcomeKeys: YES_NO,
      poolByOutcomeMotes: { yes: "1200000000100", no: "800000000000" },
      stakesByBettor: {
        "house:liquidity": { yes: "1200000000000", no: "800000000000" },
        alice: { yes: "100" },
      },
      feeBps: 200,
      winningOutcomeKey: "yes",
    });
    expect(m.feeMotes).toBe("16000000000"); // 2% of the 800e9 losing pool
    expect(m.payouts.alice).toBe("165"); // 100 + floor(100 * 784e9 / 1200000000100)
    expect(m.payouts["house:liquidity"]).toBeDefined();
    const paid = Object.values(m.payouts).reduce((s, v) => s + BigInt(v), 0n);
    expect(paid + BigInt(m.feeMotes) + BigInt(m.dustMotes)).toBe(BigInt(m.totalPoolMotes));
  });

  it("rejects a fee ≥ 100% and an unknown winning outcome", () => {
    const base: PayoutInput = {
      outcomeKeys: YES_NO,
      poolByOutcomeMotes: { yes: "1", no: "1" },
      stakesByBettor: { a: { yes: "1" }, b: { no: "1" } },
      feeBps: 200,
      winningOutcomeKey: "yes",
    };
    expect(() => computeMarketPayouts({ ...base, feeBps: 10000 })).toThrow(/feeBps/);
    expect(() => computeMarketPayouts({ ...base, winningOutcomeKey: "maybe" })).toThrow(/not one of/);
  });
});

// A tiny deterministic PRNG so property runs are reproducible (no Math.random).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("computeMarketPayouts — invariants (property-based)", () => {
  const rand = lcg(20260705);
  const outcomeKeys = ["a", "b", "c"];

  for (let iter = 0; iter < 300; iter++) {
    it(`conserves the pool and stays non-negative [#${iter}]`, () => {
      // Build a random market: N bettors each stake a random amount on a random outcome.
      const nBettors = 1 + Math.floor(rand() * 8);
      const pool: Record<string, string> = { a: "0", b: "0", c: "0" };
      const stakes: Record<string, Record<string, string>> = {};
      for (let i = 0; i < nBettors; i++) {
        const bettor = `b${i}`;
        const key = outcomeKeys[Math.floor(rand() * outcomeKeys.length)];
        const amt = 1n + BigInt(Math.floor(rand() * 1_000_000));
        stakes[bettor] = { [key]: amt.toString() };
        pool[key] = (BigInt(pool[key]) + amt).toString();
      }
      const feeBps = Math.floor(rand() * 1000); // 0–10%
      const forceVoid = rand() < 0.15;
      const winner = forceVoid ? null : outcomeKeys[Math.floor(rand() * outcomeKeys.length)];

      const m = computeMarketPayouts({
        outcomeKeys,
        poolByOutcomeMotes: pool,
        stakesByBettor: stakes,
        feeBps,
        winningOutcomeKey: winner,
      });

      const total = BigInt(m.totalPoolMotes);
      const paid = Object.values(m.payouts).reduce((s, v) => s + BigInt(v), 0n);
      const fee = BigInt(m.feeMotes);
      const dust = BigInt(m.dustMotes);

      // Conservation: nothing is created, nothing vanishes.
      expect(paid + fee + dust).toBe(total);
      // Non-negativity everywhere.
      expect(dust >= 0n).toBe(true);
      for (const v of Object.values(m.payouts)) expect(BigInt(v) >= 0n).toBe(true);

      if (m.mode === "void") {
        expect(fee).toBe(0n);
        expect(dust).toBe(0n); // refunds sum exactly to the pool
        expect(paid).toBe(total);
      } else {
        // Only backers of the winning outcome are paid.
        for (const bettor of Object.keys(m.payouts)) {
          expect(BigInt(stakes[bettor][winner!] ?? "0") > 0n).toBe(true);
        }
        // A winner never gets back less than their own stake.
        for (const [bettor, payout] of Object.entries(m.payouts)) {
          expect(BigInt(payout) >= BigInt(stakes[bettor][winner!])).toBe(true);
        }
      }
    });
  }
});

describe("previewPayoutMotes", () => {
  it("a winning bet always returns at least the stake", () => {
    const pool = { yes: "1000", no: "3000" };
    const preview = previewPayoutMotes(pool, "yes", "100", 200);
    expect(BigInt(preview) >= 100n).toBe(true);
  });

  it("is zero for a non-positive stake", () => {
    expect(previewPayoutMotes({ yes: "1", no: "1" }, "yes", "0", 200)).toBe("0");
  });

  it("larger relative share of the winning pool → larger multiple", () => {
    // Betting into a small winning pool against a big losing pool pays more per unit.
    const rich = previewPayoutMotes({ yes: "10", no: "10000" }, "yes", "10", 200);
    const thin = previewPayoutMotes({ yes: "10000", no: "10" }, "yes", "10", 200);
    expect(BigInt(rich) > BigInt(thin)).toBe(true);
  });
});
