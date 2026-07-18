/**
 * An agent's track record — PnL, volume, win rate, calibration, per-category expertise — folded
 * from chain events.
 *
 * This is the reputation asset the roadmap sells, and its credibility rests entirely on being
 * *derivable*: everything below is a pure function of the vault's own event log, so a third party
 * can recompute any number here and check it. A record that only we can produce is a record you
 * have to trust, and a credit bureau you have to trust is not a credit bureau.
 *
 * Deliberately NOT on chain. Computing Brier scores in Odra would cost gas on every bet to produce
 * a number already implied by the events — more expensive AND harder to audit.
 *
 * The forecast an agent is scored against is the price it accepted: the outcome's implied
 * probability from the pools **before** its own stake landed. Scoring against the post-bet price
 * would let an agent flatter its own calibration by betting bigger.
 */

import type { ChainEvent } from "@/ports/events";
import { compareEvents } from "@/core/indexer";
import {
  calibrationByCategory,
  calibrationScore,
  impliedProbability,
  type CalibrationSample,
  type CalibrationScore,
  type CategoryCalibration,
} from "@/core/calibration";

export interface AgentRecord {
  /** The agent's on-chain account or ledger id. */
  agent: string;
  /** Motes staked across settled markets. */
  stakedMotes: string;
  /** Motes returned by settlement. */
  returnedMotes: string;
  /** returned − staked, signed. */
  realizedPnlMotes: string;
  /** Return on stake, basis points, signed. */
  roiBps: number;
  /** Settled markets participated in. */
  settledCount: number;
  /** Of those, how many returned more than was staked. */
  wins: number;
  /** wins / settledCount, or 0 with no settled markets. */
  winRate: number;
  /** Total motes staked including markets still open — the volume figure. */
  volumeMotes: string;
  /** Bets placed, settled or not. */
  betCount: number;
  /** Distinct markets touched. */
  marketCount: number;
  /** Calibration across everything settled. */
  calibration: CalibrationScore;
  /** Calibration per market category. */
  byCategory: CategoryCalibration[];
  /** Epoch ms of the first and most recent bet — the age signal. */
  firstBetAt: number | null;
  lastBetAt: number | null;
}

/** Market metadata the fold needs but events alone do not carry (the catalogue supplies it). */
export interface MarketMeta {
  category?: string;
  feeBps?: number;
}

interface BetSnapshot {
  marketId: string;
  outcomeKey: string;
  amountMotes: bigint;
  /** Implied probability of the chosen outcome at the moment of the bet. */
  forecast: number;
  timestampMs: number;
}

interface MarketFold {
  outcomeKeys: string[];
  feeBps: number;
  poolByOutcomeMotes: Record<string, string>;
  stakesByBettor: Record<string, Record<string, string>>;
  status: "open" | "resolved" | "voided";
  winningOutcomeKey: string | null;
}

function addMotes(current: string | undefined, delta: bigint): string {
  return (BigInt(current ?? "0") + delta).toString();
}

/**
 * Fold events into per-agent track records.
 *
 * Events are sorted first, for the same reason the indexer sorts them: a bet folded after the
 * resolution it preceded would be scored against a price that did not exist when it was placed,
 * and the calibration number would be quietly fictional.
 */
export function buildAgentRecords(
  events: readonly ChainEvent[],
  meta: Record<string, MarketMeta> = {},
): AgentRecord[] {
  const markets = new Map<string, MarketFold>();
  const betsByAgent = new Map<string, BetSnapshot[]>();

  for (const event of [...events].sort(compareEvents)) {
    if (event.kind === "market_created") {
      if (!event.outcomeKeys || event.outcomeKeys.length < 2) continue;
      if (markets.has(event.marketId)) continue;
      markets.set(event.marketId, {
        outcomeKeys: [...event.outcomeKeys],
        feeBps: event.feeBps ?? meta[event.marketId]?.feeBps ?? 0,
        poolByOutcomeMotes: {},
        stakesByBettor: {},
        status: "open",
        winningOutcomeKey: null,
      });
      continue;
    }

    const market = markets.get(event.marketId);
    if (!market) continue; // stream started mid-history — the indexer reports these

    if (event.kind === "bet_placed") {
      if (!event.bettor || !event.outcomeKey || !event.amountMotes || !/^\d+$/.test(event.amountMotes)) continue;
      if (!market.outcomeKeys.includes(event.outcomeKey) || market.status !== "open") continue;
      const amount = BigInt(event.amountMotes);

      // The price BEFORE this stake lands. Read first, then apply.
      const forecast = impliedProbability(market.poolByOutcomeMotes, event.outcomeKey);
      const snapshots = betsByAgent.get(event.bettor) ?? [];
      snapshots.push({
        marketId: event.marketId,
        outcomeKey: event.outcomeKey,
        amountMotes: amount,
        forecast,
        timestampMs: event.timestampMs,
      });
      betsByAgent.set(event.bettor, snapshots);

      market.poolByOutcomeMotes[event.outcomeKey] = addMotes(
        market.poolByOutcomeMotes[event.outcomeKey],
        amount,
      );
      const byOutcome = (market.stakesByBettor[event.bettor] ??= {});
      byOutcome[event.outcomeKey] = addMotes(byOutcome[event.outcomeKey], amount);
      continue;
    }

    if (event.kind === "market_resolved" && market.status === "open") {
      if (event.voided) {
        market.status = "voided";
      } else if (event.outcomeKey && market.outcomeKeys.includes(event.outcomeKey)) {
        market.status = "resolved";
        market.winningOutcomeKey = event.outcomeKey;
      }
    }
  }

  const records: AgentRecord[] = [];
  for (const [agent, bets] of betsByAgent) {
    let staked = 0n;
    let returned = 0n;
    let volume = 0n;
    let settledCount = 0;
    let wins = 0;
    const samples: CalibrationSample[] = [];
    const marketIds = new Set<string>();
    let firstBetAt: number | null = null;
    let lastBetAt: number | null = null;

    // Per-market, so PnL is counted once even when an agent bet several times into one market.
    const byMarket = new Map<string, BetSnapshot[]>();
    for (const bet of bets) {
      marketIds.add(bet.marketId);
      volume += bet.amountMotes;
      if (firstBetAt === null || bet.timestampMs < firstBetAt) firstBetAt = bet.timestampMs;
      if (lastBetAt === null || bet.timestampMs > lastBetAt) lastBetAt = bet.timestampMs;
      (byMarket.get(bet.marketId) ?? byMarket.set(bet.marketId, []).get(bet.marketId)!).push(bet);
    }

    for (const [marketId, marketBets] of byMarket) {
      const market = markets.get(marketId);
      if (!market || market.status === "open") continue;

      const marketStake = marketBets.reduce((sum, b) => sum + b.amountMotes, 0n);
      staked += marketStake;
      settledCount += 1;

      const payout = payoutFor(market, agent);
      returned += payout;
      if (payout > marketStake) wins += 1;

      // A voided market refunds everyone: nobody forecast anything, so scoring it would punish
      // agents for a market that never resolved.
      if (market.status === "voided") continue;
      for (const bet of marketBets) {
        samples.push({
          forecast: bet.forecast,
          won: bet.outcomeKey === market.winningOutcomeKey,
          stakeMotes: bet.amountMotes.toString(),
          category: meta[marketId]?.category,
        });
      }
    }

    const pnl = returned - staked;
    records.push({
      agent,
      stakedMotes: staked.toString(),
      returnedMotes: returned.toString(),
      realizedPnlMotes: pnl.toString(),
      roiBps: staked > 0n ? Number((pnl * 10_000n) / staked) : 0,
      settledCount,
      wins,
      winRate: settledCount > 0 ? wins / settledCount : 0,
      volumeMotes: volume.toString(),
      betCount: bets.length,
      marketCount: marketIds.size,
      calibration: calibrationScore(samples),
      byCategory: calibrationByCategory(samples),
      firstBetAt,
      lastBetAt,
    });
  }

  // Best calibration first (lower Brier), then PnL, then id — deterministic, and it ranks skill
  // above luck by construction. Agents with nothing settled sort last rather than at the top,
  // which is where a "perfect" zero Brier would otherwise put them.
  records.sort((a, b) => {
    const aScored = a.calibration.sampleCount > 0;
    const bScored = b.calibration.sampleCount > 0;
    if (aScored !== bScored) return aScored ? -1 : 1;
    if (aScored && a.calibration.brier !== b.calibration.brier) {
      return a.calibration.brier - b.calibration.brier;
    }
    const pa = BigInt(a.realizedPnlMotes);
    const pb = BigInt(b.realizedPnlMotes);
    if (pa !== pb) return pb > pa ? 1 : -1;
    return a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0;
  });
  return records;
}

/**
 * What settlement pays one bettor in one market — the same parimutuel math the vault's `claim()`
 * runs: a void refunds the full stake, a loser gets nothing, and a winner takes its stake plus a
 * pro-rata share of the losing pool net of fee.
 *
 * Inlined rather than routed through `computeMarketPayouts` because the fold needs one bettor's
 * number, not the whole manifest — and integer division is applied in the same order, so the two
 * agree to the mote (asserted in the tests).
 */
function payoutFor(market: MarketFold, bettor: string): bigint {
  const stakes = market.stakesByBettor[bettor];
  if (!stakes) return 0n;
  const totalStake = Object.values(stakes).reduce((sum, v) => sum + BigInt(v), 0n);
  if (market.status === "voided" || market.winningOutcomeKey === null) return totalStake;

  const winningStake = BigInt(stakes[market.winningOutcomeKey] ?? "0");
  if (winningStake === 0n) return 0n;

  let winningPool = 0n;
  let totalPool = 0n;
  for (const [key, value] of Object.entries(market.poolByOutcomeMotes)) {
    const amount = BigInt(value);
    totalPool += amount;
    if (key === market.winningOutcomeKey) winningPool += amount;
  }
  const losingPool = totalPool - winningPool;
  const fee = (losingPool * BigInt(market.feeBps)) / 10_000n;
  const distributable = losingPool - fee;
  return winningStake + (distributable * winningStake) / winningPool;
}
