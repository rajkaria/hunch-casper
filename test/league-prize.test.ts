import { describe, expect, it } from "vitest";
import { leaguePrizePool, prizeShares, splitIsWhole, PRIZE_SPLIT_BPS } from "@/core/league-prize";

const CSPR = 1_000_000_000n;

describe("prize pool declaration", () => {
  it("is unfunded until an operator declares one", () => {
    // Advertising a prize that does not exist is worse than not running the league.
    const p = leaguePrizePool({});
    expect(p.funded).toBe(false);
    expect(p.totalMotes).toBe("0");
  });

  it("treats zero and junk as unfunded rather than as a prize", () => {
    expect(leaguePrizePool({ CASPER_LEAGUE_PRIZE_MOTES: "0" }).funded).toBe(false);
    expect(leaguePrizePool({ CASPER_LEAGUE_PRIZE_MOTES: "abc" }).funded).toBe(false);
    expect(leaguePrizePool({ CASPER_LEAGUE_PRIZE_MOTES: "-5" }).funded).toBe(false);
  });

  it("reports a declared pool with its network", () => {
    const p = leaguePrizePool({ CASPER_LEAGUE_PRIZE_MOTES: (500n * CSPR).toString() });
    expect(p.funded).toBe(true);
    expect(p.network).toBe("testnet");
  });

  it("never blurs testnet CSPR into mainnet money", () => {
    expect(
      leaguePrizePool({
        CASPER_LEAGUE_PRIZE_MOTES: "1",
        NEXT_PUBLIC_DEFAULT_NETWORK: "mainnet",
      }).network,
    ).toBe("mainnet");
  });
});

describe("prize split", () => {
  it("the declared split is a whole pool", () => {
    expect(splitIsWhole()).toBe(true);
  });

  it("conserves the pool exactly across three places", () => {
    const total = 1000n * CSPR;
    const shares = prizeShares(total.toString(), 3);
    expect(shares.reduce((a, s) => a + BigInt(s), 0n)).toBe(total);
  });

  it("conserves exactly even when the pool divides badly", () => {
    // A prize table that loses motes to rounding is the same defect as a payout engine that does.
    for (const total of [1n, 7n, 999n, 1_000_000_007n, 12_345_678_901n]) {
      const shares = prizeShares(total.toString(), 3);
      expect(shares.reduce((a, s) => a + BigInt(s), 0n)).toBe(total);
    }
  });

  it("gives the rounding remainder to first place, never drops it", () => {
    const shares = prizeShares("7", 3);
    expect(BigInt(shares[0])).toBeGreaterThanOrEqual(BigInt(shares[1]));
    expect(shares.reduce((a, s) => a + BigInt(s), 0n)).toBe(7n);
  });

  it("renormalises when fewer agents clear the floor than there are places", () => {
    // Otherwise an unclaimed third-place share silently vanishes from the pool.
    const total = 100n * CSPR;
    const two = prizeShares(total.toString(), 2);
    expect(two).toHaveLength(2);
    expect(two.reduce((a, s) => a + BigInt(s), 0n)).toBe(total);
  });

  it("pays nothing from an unfunded pool", () => {
    expect(prizeShares("0", 3)).toEqual([]);
    expect(prizeShares("abc", 3)).toEqual([]);
  });

  it("pays nothing when nobody qualifies", () => {
    expect(prizeShares((100n * CSPR).toString(), 0)).toEqual([]);
  });

  it("never pays more places than the split defines", () => {
    expect(prizeShares((100n * CSPR).toString(), 99)).toHaveLength(PRIZE_SPLIT_BPS.length);
  });

  it("ranks the shares descending", () => {
    const shares = prizeShares((900n * CSPR).toString(), 3).map(BigInt);
    expect(shares[0]).toBeGreaterThan(shares[1]);
    expect(shares[1]).toBeGreaterThan(shares[2]);
  });
});
