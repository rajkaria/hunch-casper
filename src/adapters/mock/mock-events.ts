/**
 * Deterministic mock `EventsPort`. Replays a fixed event log so the indexer, the boards, and the
 * live-feed UI can be exercised with no chain, no credentials, and no wall clock.
 *
 * `subscribe` delivers the remaining log on a timer rather than resolving instantly, because the
 * bugs worth catching here are ordering and reconnection bugs, and those only exist when events
 * arrive over time.
 */

import type { CasperNetwork } from "@/config/network";
import type { ChainEvent, EventQuery, EventsPort } from "@/ports/events";
import { pseudoDeployHash } from "./mock-chain";

/** Builder that fills in the boring fields, so fixtures read as the story they encode. */
export function mockEvent(partial: Partial<ChainEvent> & { kind: ChainEvent["kind"]; marketId: string }): ChainEvent {
  const blockHeight = partial.blockHeight ?? 1;
  const eventIndex = partial.eventIndex ?? 0;
  return {
    blockHeight,
    eventIndex,
    deployHash: partial.deployHash ?? pseudoDeployHash(`${partial.kind}:${partial.marketId}:${blockHeight}:${eventIndex}`),
    timestampMs: partial.timestampMs ?? 1_780_000_000_000 + blockHeight * 30_000,
    ...partial,
  };
}

/** A complete market lifecycle — created, bet on by two agents, resolved — as an event log. */
export function demoEventLog(marketId = "coin-flip-5m"): ChainEvent[] {
  return [
    mockEvent({
      kind: "market_created",
      marketId,
      blockHeight: 100,
      eventIndex: 0,
      feeBps: 200,
      outcomeKeys: ["heads", "tails"],
      oracle: "arbiter",
    }),
    mockEvent({
      kind: "bet_placed",
      marketId,
      blockHeight: 101,
      eventIndex: 0,
      bettor: "agent:momentum",
      outcomeKey: "heads",
      amountMotes: "3000000000",
    }),
    mockEvent({
      kind: "bet_placed",
      marketId,
      blockHeight: 101,
      eventIndex: 1,
      bettor: "agent:contrarian",
      outcomeKey: "tails",
      amountMotes: "2000000000",
    }),
    mockEvent({
      kind: "market_resolved",
      marketId,
      blockHeight: 110,
      eventIndex: 0,
      outcomeKey: "heads",
      oracleId: "arbiter",
    }),
  ];
}

export interface MockEventsOptions {
  /** The log to serve. Defaults to `demoEventLog()`. */
  events?: ChainEvent[];
  /** Milliseconds between delivered events on `subscribe`. */
  intervalMs?: number;
}

export function createMockEvents(network: CasperNetwork, opts: MockEventsOptions = {}): EventsPort {
  const log = opts.events ?? demoEventLog();
  const intervalMs = opts.intervalMs ?? 50;

  return {
    network,

    async fetch(query: EventQuery = {}): Promise<ChainEvent[]> {
      const from = query.fromBlockHeight ?? 0;
      const filtered = log
        .filter((e) => e.blockHeight >= from)
        .sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex);
      return query.limit ? filtered.slice(0, query.limit) : filtered;
    },

    subscribe(onEvent): () => void {
      let index = 0;
      const timer = setInterval(() => {
        if (index >= log.length) {
          clearInterval(timer);
          return;
        }
        onEvent(log[index++]);
      }, intervalMs);
      return () => clearInterval(timer);
    },
  };
}
