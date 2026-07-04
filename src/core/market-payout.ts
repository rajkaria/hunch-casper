/**
 * The parimutuel payout engine — the single, pure, deterministic authority for who is owed
 * what when a market settles. It reproduces the on-chain vault's claim() ALGORITHM
 * (`contracts/src/parimutuel_market.rs`) exactly: given the same escrowed stakes — including the
 * house launch liquidity, which is a real staker escrowed on-chain at deploy, not a display-only
 * fiction — it returns the same integer payouts the on-chain `claim()` pays. The on-chain
 * `claim()` remains the real money authority; this lets the app, the Arbiter, and the UI compute
 * and preview the identical numbers without a chain round-trip. Parity vectors (including a
 * seeded market) pin the two algorithms together so they can never drift.
 *
 * HARD RULE (ported from Hunch): an LLM never touches this path. Payouts are pool math.
 *
 * Semantics (identical to the Odra `ParimutuelMarket`):
 *   • fee is taken ONLY from the losing pool: `fee = floor(losing * feeBps / 10_000)`.
 *   • winners split `distributableLosing = losing - fee` pro-rata to their winning stake, on
 *     top of getting their own stake back:
 *       payout = stake + floor(stake * distributableLosing / winningPool)
 *   • degenerate rounds refund full gross, no fee:
 *       - nobody on the winning side (`winningPool == 0`) → auto-void, everyone refunded;
 *       - no losers / everyone on the winning side (`distributableLosing == 0`) → stake back;
 *       - explicit void (`winningOutcomeKey === null`, e.g. a flat up/down round) → refund all.
 *   • integer division floors, so a few motes of "dust" can remain in the vault — surfaced
 *     here as `dustMotes` so conservation is explicit and auditable.
 */

import { MOTES_PER_CSPR } from "@/core/types";

const BPS_DENOMINATOR = 10_000n;

export type SettlementMode = "resolved" | "void";

export interface PayoutInput {
  /** The market's valid outcome keys (used to validate the winning key). */
  outcomeKeys: string[];
  /** Total staked per outcome key, in motes. */
  poolByOutcomeMotes: Record<string, string>;
  /** Per-bettor stake per outcome: `bettor -> (outcomeKey -> motes)`. */
  stakesByBettor: Record<string, Record<string, string>>;
  /** Parimutuel fee in basis points (0 ≤ feeBps < 10_000), taken only from the losing pool. */
  feeBps: number;
  /** The oracle's winning outcome, or `null` to void the round (flat / undecidable). */
  winningOutcomeKey: string | null;
}

export interface PayoutManifest {
  mode: SettlementMode;
  winningOutcomeKey: string | null;
  totalPoolMotes: string;
  winningPoolMotes: string;
  /** Fee swept to treasury (0 on void / no-loser rounds), in motes. */
  feeMotes: string;
  /** Losing pool net of fee, split among winners, in motes. */
  distributableLosingMotes: string;
  /** `bettor -> payout motes` — only bettors owed a positive amount. */
  payouts: Record<string, string>;
  /** Motes left in the vault from integer-division flooring (≥ 0). */
  dustMotes: string;
}

function sum(motesByKey: Record<string, string>): bigint {
  let total = 0n;
  for (const v of Object.values(motesByKey)) total += BigInt(v);
  return total;
}

function assertFee(feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= Number(BPS_DENOMINATOR)) {
    throw new Error(`feeBps must be an integer in [0, ${BPS_DENOMINATOR}), got ${feeBps}`);
  }
  return BigInt(feeBps);
}

/**
 * Compute the settlement manifest for a market. Pure: no I/O, no clock, no randomness. Given
 * the same pools + stakes + fee + winner, always returns the same payouts — the on-chain claim
 * math, off-chain.
 */
export function computeMarketPayouts(input: PayoutInput): PayoutManifest {
  const feeBps = assertFee(input.feeBps);
  const { winningOutcomeKey } = input;
  if (winningOutcomeKey !== null && !input.outcomeKeys.includes(winningOutcomeKey)) {
    throw new Error(`winningOutcomeKey '${winningOutcomeKey}' is not one of the market's outcomes`);
  }

  const total = sum(input.poolByOutcomeMotes);

  // Per-bettor total stake across all outcomes (used for void refunds).
  const bettorTotal: Record<string, bigint> = {};
  for (const [bettor, byOutcome] of Object.entries(input.stakesByBettor)) {
    bettorTotal[bettor] = sum(byOutcome);
  }

  const winningPool = winningOutcomeKey === null ? 0n : BigInt(input.poolByOutcomeMotes[winningOutcomeKey] ?? "0");

  // Void: explicit (null) or no-winner (winning pool empty). Refund every bettor's full stake.
  if (winningOutcomeKey === null || winningPool === 0n) {
    const payouts: Record<string, string> = {};
    let paid = 0n;
    for (const [bettor, amt] of Object.entries(bettorTotal)) {
      if (amt > 0n) {
        payouts[bettor] = amt.toString();
        paid += amt;
      }
    }
    return {
      mode: "void",
      winningOutcomeKey: null,
      totalPoolMotes: total.toString(),
      winningPoolMotes: "0",
      feeMotes: "0",
      distributableLosingMotes: "0",
      payouts,
      dustMotes: (total - paid).toString(),
    };
  }

  // Resolved: fee from the losing pool, winners split the remainder pro-rata to winning stake.
  const losing = total - winningPool;
  const fee = (losing * feeBps) / BPS_DENOMINATOR;
  const distributableLosing = losing - fee;

  const payouts: Record<string, string> = {};
  let paidToWinners = 0n;
  for (const [bettor, byOutcome] of Object.entries(input.stakesByBettor)) {
    const stake = BigInt(byOutcome[winningOutcomeKey] ?? "0");
    if (stake === 0n) continue; // losers get nothing
    const payout = distributableLosing === 0n ? stake : stake + (stake * distributableLosing) / winningPool;
    payouts[bettor] = payout.toString();
    paidToWinners += payout;
  }

  return {
    mode: "resolved",
    winningOutcomeKey,
    totalPoolMotes: total.toString(),
    winningPoolMotes: winningPool.toString(),
    feeMotes: fee.toString(),
    distributableLosingMotes: distributableLosing.toString(),
    payouts,
    dustMotes: (total - fee - paidToWinners).toString(),
  };
}

/**
 * A single bettor's expected payout if `outcomeKey` wins, at the current pool sizes — the pure
 * "you'd win X" preview for the bet panel. Uses the same math as settlement (add the new stake
 * to its side, then compute this bettor's winning share), so the preview never over-promises.
 */
export function previewPayoutMotes(
  poolByOutcomeMotes: Record<string, string>,
  outcomeKey: string,
  stakeMotes: string,
  feeBps: number,
): string {
  const feeBpsBig = assertFee(feeBps);
  const stake = BigInt(stakeMotes);
  if (stake <= 0n) return "0";

  const pools = { ...poolByOutcomeMotes };
  pools[outcomeKey] = (BigInt(pools[outcomeKey] ?? "0") + stake).toString();
  const total = sum(pools);
  const winningPool = BigInt(pools[outcomeKey]);
  const losing = total - winningPool;
  const fee = (losing * feeBpsBig) / BPS_DENOMINATOR;
  const distributableLosing = losing - fee;
  const payout = distributableLosing === 0n ? stake : stake + (stake * distributableLosing) / winningPool;
  return payout.toString();
}

/** 1 CSPR in motes, re-exported so callers building payout inputs stay unit-consistent. */
export { MOTES_PER_CSPR };
