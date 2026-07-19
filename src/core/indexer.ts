/**
 * The chain-event indexer — pure.
 *
 * Folds a stream of `HunchVault` events into the same board inputs the app serves, using the same
 * payout engine the vault's `claim()` pays from. That equivalence is the point: today a
 * leaderboard is a number this server remembers, and the meta-markets settle against it. After
 * this, it is a number anyone can recompute from the chain and check. A reputation system whose
 * inputs cannot be independently reproduced is a reputation system you have to trust, which is the
 * thing prediction markets exist to avoid.
 *
 * No adapter imports, no clock, no I/O: give it the same events in any order and it returns the
 * same boards.
 *
 * Ordering is enforced here rather than assumed. SSE reconnects, backfills, and multi-node reads
 * routinely deliver events out of order, and a resolution folded before the bets it settles would
 * produce a market with a winner and empty pools — a silently wrong payout. `(blockHeight,
 * eventIndex)` is the total order; anything else is arrival noise.
 */

import type { ChainEvent } from "@/ports/events";
import { computeMarketPayouts, type PayoutManifest } from "@/core/market-payout";
import type { SettledStakeEntry } from "@/core/agent-leaderboard";

/** A market's state as folded from its events. */
export interface IndexedMarket {
  marketId: string;
  feeBps: number;
  outcomeKeys: string[];
  oracle?: string;
  /** `outcomeKey -> motes`. */
  poolByOutcomeMotes: Record<string, string>;
  /** `bettor -> (outcomeKey -> motes)`. */
  stakesByBettor: Record<string, Record<string, string>>;
  status: "open" | "resolved" | "voided";
  winningOutcomeKey: string | null;
  /** Who resolved it — the input to the oracle-accuracy board. */
  resolvedBy?: string;
  /** Bettors who have claimed on chain. Diagnostic: payouts are owed whether claimed or not. */
  claimants: string[];
  /** Highest block height any of this market's events came from. */
  lastBlockHeight: number;
}

export interface IndexerState {
  markets: Record<string, IndexedMarket>;
  /** Highest block height folded — the resume point for an incremental catch-up. */
  lastBlockHeight: number;
  /** Events folded, including ones that changed nothing. */
  eventCount: number;
  /** Events skipped as unusable, with the reason — surfaced rather than silently dropped. */
  skipped: { event: ChainEvent; reason: string }[];
}

function emptyState(): IndexerState {
  return { markets: {}, lastBlockHeight: 0, eventCount: 0, skipped: [] };
}

/** Total order over events. Ties on (height, index) fall back to the deploy hash for stability. */
export function compareEvents(a: ChainEvent, b: ChainEvent): number {
  if (a.blockHeight !== b.blockHeight) return a.blockHeight - b.blockHeight;
  if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
  return a.deployHash < b.deployHash ? -1 : a.deployHash > b.deployHash ? 1 : 0;
}

function addMotes(current: string | undefined, delta: string): string {
  return (BigInt(current ?? "0") + BigInt(delta)).toString();
}

const MOTES = /^\d+$/;

/**
 * Fold events into indexer state.
 *
 * Every rejection is recorded in `skipped` rather than thrown or ignored. Throwing would let one
 * malformed event stop a whole rebuild; ignoring would let a board quietly disagree with the chain
 * while looking healthy. A visible skip list is the only version an operator can act on.
 */
export function indexEvents(events: readonly ChainEvent[], initial?: IndexerState): IndexerState {
  const state: IndexerState = initial
    ? { ...initial, markets: { ...initial.markets }, skipped: [...initial.skipped] }
    : emptyState();

  for (const event of [...events].sort(compareEvents)) {
    state.eventCount += 1;
    state.lastBlockHeight = Math.max(state.lastBlockHeight, event.blockHeight);
    const skip = (reason: string): void => {
      state.skipped.push({ event, reason });
    };

    if (event.kind === "market_created") {
      if (!event.outcomeKeys || event.outcomeKeys.length < 2) {
        skip("market_created without at least two outcome keys");
        continue;
      }
      // Re-creation is impossible on chain (the vault reverts `MarketExists`), so a duplicate is a
      // replayed event: keep the first, which is the one bets were folded against.
      if (state.markets[event.marketId]) continue;
      state.markets[event.marketId] = {
        marketId: event.marketId,
        feeBps: event.feeBps ?? 0,
        outcomeKeys: [...event.outcomeKeys],
        oracle: event.oracle,
        poolByOutcomeMotes: {},
        stakesByBettor: {},
        status: "open",
        winningOutcomeKey: null,
        claimants: [],
        lastBlockHeight: event.blockHeight,
      };
      continue;
    }

    const market = state.markets[event.marketId];
    if (!market) {
      // A bet on a market we never saw created means the stream started mid-history. Folding it
      // would invent a market with no fee and no outcome list, and every payout computed from it
      // would be wrong — better to skip loudly and let the caller backfill from an earlier block.
      skip("event for a market with no market_created (stream started mid-history)");
      continue;
    }
    market.lastBlockHeight = Math.max(market.lastBlockHeight, event.blockHeight);

    switch (event.kind) {
      case "bet_placed": {
        if (!event.bettor || !event.outcomeKey || !event.amountMotes || !MOTES.test(event.amountMotes)) {
          skip("bet_placed missing bettor, outcome, or a valid motes amount");
          break;
        }
        if (!market.outcomeKeys.includes(event.outcomeKey)) {
          skip(`bet_placed on '${event.outcomeKey}', which is not an outcome of ${event.marketId}`);
          break;
        }
        if (market.status !== "open") {
          // The vault rejects bets after resolution, so this is a replay or a reordered stream.
          skip("bet_placed after the market resolved");
          break;
        }
        market.poolByOutcomeMotes[event.outcomeKey] = addMotes(
          market.poolByOutcomeMotes[event.outcomeKey],
          event.amountMotes,
        );
        const byOutcome = (market.stakesByBettor[event.bettor] ??= {});
        byOutcome[event.outcomeKey] = addMotes(byOutcome[event.outcomeKey], event.amountMotes);
        break;
      }
      case "market_resolved": {
        if (market.status !== "open") break; // idempotent: first resolution wins
        if (event.voided) {
          market.status = "voided";
          market.winningOutcomeKey = null;
        } else {
          if (!event.outcomeKey || !market.outcomeKeys.includes(event.outcomeKey)) {
            skip(`market_resolved to '${event.outcomeKey}', which is not an outcome of ${event.marketId}`);
            break;
          }
          market.status = "resolved";
          market.winningOutcomeKey = event.outcomeKey;
        }
        market.resolvedBy = event.oracleId;
        break;
      }
      case "payout_claimed": {
        if (event.claimant && !market.claimants.includes(event.claimant)) {
          market.claimants.push(event.claimant);
        }
        break;
      }
    }
  }

  return state;
}

/** The settlement manifest for an indexed market, or `null` while it is still open. */
export function manifestFor(market: IndexedMarket): PayoutManifest | null {
  if (market.status === "open") return null;
  return computeMarketPayouts({
    outcomeKeys: market.outcomeKeys,
    poolByOutcomeMotes: market.poolByOutcomeMotes,
    stakesByBettor: market.stakesByBettor,
    feeBps: market.feeBps,
    winningOutcomeKey: market.status === "voided" ? null : market.winningOutcomeKey,
  });
}

/**
 * Settled markets in the shape `computeAgentLeaderboard` takes — so the event-derived board runs
 * through the exact same pure function as the in-memory one. Two independent paths to the same
 * number is what makes the comparison meaningful; two implementations of the number would not be.
 */
export function settledEntriesFrom(state: IndexerState): SettledStakeEntry[] {
  const entries: SettledStakeEntry[] = [];
  for (const market of Object.values(state.markets)) {
    const manifest = manifestFor(market);
    if (!manifest) continue;
    entries.push({ stakesByBettor: market.stakesByBettor, manifest });
  }
  return entries;
}

/** One oracle's resolution count, folded from events. Accuracy needs an outcome check on top. */
export interface OracleActivity {
  oracleId: string;
  resolved: number;
  marketIds: string[];
}

/** Resolutions per oracle, oldest market first, deterministic by oracle id. */
export function oracleActivityFrom(state: IndexerState): OracleActivity[] {
  const byOracle = new Map<string, OracleActivity>();
  const markets = Object.values(state.markets).sort((a, b) => a.lastBlockHeight - b.lastBlockHeight);
  for (const market of markets) {
    if (!market.resolvedBy || market.status === "open") continue;
    const entry = byOracle.get(market.resolvedBy) ?? {
      oracleId: market.resolvedBy,
      resolved: 0,
      marketIds: [],
    };
    entry.resolved += 1;
    entry.marketIds.push(market.marketId);
    byOracle.set(market.resolvedBy, entry);
  }
  return [...byOracle.values()].sort((a, b) => (a.oracleId < b.oracleId ? -1 : 1));
}
