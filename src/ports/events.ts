/**
 * EventsPort — the chain's event stream, as the app consumes it.
 *
 * Two things depend on this. The UI wants bets and resolutions to *appear* rather than turn up on
 * the next poll. More importantly, the boards want a source that is not this server's memory: a
 * leaderboard folded from on-chain events is a claim anyone can recompute from the chain, whereas
 * a leaderboard folded from in-process ledgers is a number you have to take our word for. The
 * meta-markets settle against those boards, so "take our word for it" is not good enough.
 *
 * Implementations: `adapters/mock/mock-events.ts` (a deterministic fixture stream) and
 * `adapters/casper/stream-events.ts` (CSPR.cloud SSE with a polling fallback). Same interface.
 */

import type { CasperNetwork } from "../config/network";

export type ChainEventKind = "market_created" | "bet_placed" | "market_resolved" | "payout_claimed";

/**
 * One event as emitted by `HunchVault` and normalised for the fold.
 *
 * `blockHeight` and `eventIndex` together are the ordering key. Ordering matters more than it
 * looks: a resolution folded before the bets it settles produces a market with a winner and no
 * pools, so the fold must be able to sort deterministically rather than trusting arrival order —
 * SSE reconnects and backfills routinely deliver events out of order.
 */
export interface ChainEvent {
  kind: ChainEventKind;
  /** Market id inside the vault — the catalogue slug. */
  marketId: string;
  blockHeight: number;
  eventIndex: number;
  /** Transaction hash that emitted it — the audit link for anything folded from it. */
  deployHash: string;
  /** Epoch ms, from the block. */
  timestampMs: number;

  // ── kind-specific fields (absent when not applicable) ──
  /** `bet_placed` / `market_resolved`: the outcome bet on, or the winning outcome. */
  outcomeKey?: string;
  /** `bet_placed`: staked motes. */
  amountMotes?: string;
  /** `bet_placed`: the bettor's on-chain account or agent id. */
  bettor?: string;
  /** `market_created`: the market's parimutuel fee. */
  feeBps?: number;
  /** `market_created`: outcome keys, in order. */
  outcomeKeys?: string[];
  /** `market_created`: the account bound as oracle. */
  oracle?: string;
  /** `market_resolved`: the resolving oracle. */
  oracleId?: string;
  /** `market_resolved`: true when the round was voided rather than won. */
  voided?: boolean;
  /** `payout_claimed`: claimant and amount. */
  claimant?: string;
}

export interface EventQuery {
  /** Only events at or after this block height. */
  fromBlockHeight?: number;
  /** Cap on returned events. */
  limit?: number;
}

export interface EventsPort {
  readonly network: CasperNetwork;
  /** Historical events, oldest first — how a cold instance rebuilds its boards. */
  fetch(query?: EventQuery): Promise<ChainEvent[]>;
  /**
   * Live events. Returns an unsubscribe function. An implementation that cannot stream MUST fall
   * back to polling rather than returning nothing: a silent no-op subscription looks identical to
   * a quiet chain, and the UI would simply stop updating with no error anywhere.
   */
  subscribe(onEvent: (event: ChainEvent) => void, onError?: (err: unknown) => void): () => void;
}
