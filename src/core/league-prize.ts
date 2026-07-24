/**
 * The Agent League's prize pool — declared config, split by pure arithmetic.
 *
 * A league nobody can win is a leaderboard. A prize is what converts the treasury from fuel into a
 * reason for a stranger to write an agent, which is the only traction metric this project actually
 * cares about: agents on the board that the operator does not own.
 *
 * Two honesty rules are baked in rather than left to the UI:
 *
 * 1. **An unfunded pool says so.** `CASPER_LEAGUE_PRIZE_MOTES` unset means there is no prize, and
 *    every surface must render that plainly. Advertising a prize that does not exist is the one
 *    thing that would make the league worse than not running it.
 * 2. **The split is exact.** Integer motes, remainder to first place, Σ shares == pool. A prize
 *    table that quietly loses motes to rounding is the same class of defect as a payout engine
 *    that does.
 */

/** Share of the pool per finishing position, in basis points. Must sum to 10,000. */
export const PRIZE_SPLIT_BPS = [5000, 3000, 2000] as const;

const BPS_DENOMINATOR = 10_000n;

export interface PrizePool {
  /** Total pool in motes. `"0"` means unfunded — say so, never imply otherwise. */
  totalMotes: string;
  /** True when an operator has actually declared a pool. */
  funded: boolean;
  /** Network the pool is denominated on. Testnet CSPR is not real money; the UI must not blur that. */
  network: "testnet" | "mainnet";
}

/** Read the declared pool from config. Absent, malformed or zero all mean "unfunded". */
export function leaguePrizePool(env: Record<string, string | undefined> = process.env): PrizePool {
  const raw = env.CASPER_LEAGUE_PRIZE_MOTES;
  const network = env.NEXT_PUBLIC_DEFAULT_NETWORK === "mainnet" ? "mainnet" : "testnet";
  if (!raw || !/^\d+$/.test(raw) || BigInt(raw) === 0n) {
    return { totalMotes: "0", funded: false, network };
  }
  return { totalMotes: raw, funded: true, network };
}

/**
 * Split a pool across the top finishers.
 *
 * The remainder from integer division goes to first place rather than being dropped: Σ shares must
 * equal the pool exactly, or the league owes motes it never pays.
 */
export function prizeShares(totalMotes: string, winners: number): string[] {
  const total = /^\d+$/.test(totalMotes) ? BigInt(totalMotes) : 0n;
  const places = Math.max(0, Math.min(winners, PRIZE_SPLIT_BPS.length));
  if (places === 0 || total === 0n) return [];

  // Renormalise when fewer agents cleared the floor than there are prize places — otherwise an
  // unclaimed third-place share would silently vanish from the pool.
  const activeBps = PRIZE_SPLIT_BPS.slice(0, places);
  const bpsTotal = activeBps.reduce((a, b) => a + BigInt(b), 0n);

  const shares = activeBps.map((bps) => (total * BigInt(bps)) / bpsTotal);
  const distributed = shares.reduce((a, b) => a + b, 0n);
  shares[0] += total - distributed; // remainder to first, so Σ == pool exactly
  return shares.map((s) => s.toString());
}

/** Sanity: the declared split is a whole pool. Pinned by a test so a future edit cannot break it. */
export function splitIsWhole(): boolean {
  return PRIZE_SPLIT_BPS.reduce((a, b) => a + BigInt(b), 0n) === BPS_DENOMINATOR;
}
