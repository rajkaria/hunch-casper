/**
 * The economy's headline numbers, folded from chain events.
 *
 * Every figure here is derived from the same event stream `/api/boards` folds, so a reader can
 * recompute all of it from the chain rather than taking the site's word for it. That is the whole
 * point: a traction number nobody can check is marketing, and this project's claim is that its
 * numbers are auditable.
 *
 * Pure — the caller supplies the events and the clock.
 */

import type { ChainEvent } from "@/ports/events";
import { baseSlug } from "@/core/round-id";

export interface EconomyStats {
  /** Distinct catalogue markets (rounds collapsed onto their parent slug). */
  markets: number;
  /** Distinct market ROUNDS opened — a recurring market contributes one per round. */
  rounds: number;
  /** Rounds that reached a resolution. */
  settled: number;
  bets: number;
  /** Total staked across every folded bet, in motes. */
  stakedMotes: string;
  /** Total paid out across every folded claim, in motes. */
  paidOutMotes: string;
  /** Distinct bettors — the number that matters for traction: agents we do not own. */
  bettors: number;
  /** Distinct agents that resolved something. */
  oracles: number;
  /** Highest block the fold has seen — the "as of" for every number above. */
  lastBlockHeight: number;
  /** How many events produced these figures, so a zero is distinguishable from a blind fold. */
  eventCount: number;
}

const EMPTY: EconomyStats = {
  markets: 0,
  rounds: 0,
  settled: 0,
  bets: 0,
  stakedMotes: "0",
  paidOutMotes: "0",
  bettors: 0,
  oracles: 0,
  lastBlockHeight: 0,
  eventCount: 0,
};

function addMotes(total: bigint, raw: string | undefined): bigint {
  if (!raw || !/^\d+$/.test(raw)) return total;
  return total + BigInt(raw);
}

/** Fold chain events into the headline numbers. */
export function computeStats(events: ChainEvent[]): EconomyStats {
  if (events.length === 0) return { ...EMPTY };

  const markets = new Set<string>();
  const rounds = new Set<string>();
  const settledRounds = new Set<string>();
  const bettors = new Set<string>();
  const oracles = new Set<string>();
  let bets = 0;
  let staked = 0n;
  let paidOut = 0n;
  let lastBlockHeight = 0;

  for (const e of events) {
    rounds.add(e.marketId);
    markets.add(baseSlug(e.marketId));
    if (e.blockHeight > lastBlockHeight) lastBlockHeight = e.blockHeight;

    switch (e.kind) {
      case "bet_placed":
        bets++;
        staked = addMotes(staked, e.amountMotes);
        if (e.bettor) bettors.add(e.bettor);
        break;
      case "market_resolved":
        settledRounds.add(e.marketId);
        if (e.oracleId) oracles.add(e.oracleId);
        break;
      case "payout_claimed":
        paidOut = addMotes(paidOut, e.amountMotes);
        break;
      case "market_created":
        break;
    }
  }

  return {
    markets: markets.size,
    rounds: rounds.size,
    settled: settledRounds.size,
    bets,
    stakedMotes: staked.toString(),
    paidOutMotes: paidOut.toString(),
    bettors: bettors.size,
    oracles: oracles.size,
    lastBlockHeight,
    eventCount: events.length,
  };
}

/** Motes → a short human string ("1,234 CSPR"). Floors, so a figure never overstates. */
export function formatCspr(motes: string): string {
  const n = /^\d+$/.test(motes) ? BigInt(motes) : 0n;
  return (n / 1_000_000_000n).toLocaleString("en-US");
}
