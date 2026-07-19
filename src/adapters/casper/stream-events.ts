/**
 * Real `EventsPort` — CSPR.cloud contract events over SSE, with polling as the fallback.
 *
 * Fetch-only, no SDK: the network edge is a plain HTTP read and the decoding is pure, so the part
 * most likely to be wrong (mapping CSPR.cloud's payload onto our event shape) is asserted offline
 * against fixtures rather than against a live stream.
 *
 * **The fallback is not optional.** A subscription that silently does nothing when streaming is
 * unavailable is indistinguishable from a quiet chain: the UI stops updating, the boards stop
 * advancing, and nothing anywhere reports an error. So a stream that cannot be opened, or that
 * drops, degrades to polling — slower, visibly working, and self-healing when SSE returns.
 */

import type { CasperNetwork } from "@/config/network";
import { getNetworkConfig } from "@/config/network";
import type { ChainEvent, ChainEventKind, EventQuery, EventsPort } from "@/ports/events";

const FETCH_TIMEOUT_MS = 8_000;
/** Poll cadence when streaming is unavailable. Well inside the 10-minute economy tick. */
export const POLL_INTERVAL_MS = 15_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function motes(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * The vault's Odra event names, mapped to our kinds. Anything else on the contract's stream —
 * `OracleApproved`, `CreationOpened`, `BondRefunded` — is deliberately unmapped: the indexer folds
 * money and outcomes, and quietly accepting an unknown event as a known one is how a board ends up
 * confidently wrong.
 */
const EVENT_KINDS: Record<string, ChainEventKind> = {
  MarketCreated: "market_created",
  BetPlaced: "bet_placed",
  MarketResolved: "market_resolved",
  MarketVoided: "market_resolved",
  PayoutClaimed: "payout_claimed",
};

/**
 * PURE decode of one CSPR.cloud contract-event payload. Returns `null` for anything unrecognised,
 * unmapped, or missing its ordering key — never throws, so one malformed frame cannot kill a
 * stream that is otherwise healthy.
 */
export function decodeChainEvent(raw: unknown): ChainEvent | null {
  const root = asRecord(raw);
  if (!root) return null;
  const name = str(root.name) ?? str(root.event_name);
  if (!name) return null;
  const kind = EVENT_KINDS[name];
  if (!kind) return null;

  const data = asRecord(root.data) ?? asRecord(root.fields) ?? {};
  const marketId = str(data.market_id) ?? str(root.market_id);
  const blockHeight = num(root.block_height) ?? num(root.block);
  const deployHash = str(root.deploy_hash) ?? str(root.transaction_hash);
  if (!marketId || blockHeight === undefined || !deployHash) return null;

  const timestampMs = (() => {
    const ts = root.timestamp;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") {
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  })();

  const event: ChainEvent = {
    kind,
    marketId,
    blockHeight,
    eventIndex: num(root.event_index) ?? 0,
    deployHash,
    timestampMs,
  };

  if (kind === "bet_placed") {
    event.bettor = str(data.bettor) ?? str(data.caller);
    event.outcomeKey = str(data.outcome);
    event.amountMotes = motes(data.amount);
  } else if (kind === "market_created") {
    event.feeBps = num(data.fee_bps);
    event.oracle = str(data.oracle);
    const outcomes = data.outcomes;
    if (Array.isArray(outcomes)) {
      event.outcomeKeys = outcomes.filter((o): o is string => typeof o === "string");
    }
  } else if (kind === "market_resolved") {
    // `MarketVoided` carries no winning outcome — that absence IS the void, and it must not be
    // folded as "resolved to undefined", which would settle winners against an empty pool.
    event.voided = name === "MarketVoided";
    event.outcomeKey = str(data.winning_outcome);
    event.oracleId = str(data.oracle) ?? str(data.caller);
  } else if (kind === "payout_claimed") {
    event.claimant = str(data.bettor) ?? str(data.claimant);
    event.amountMotes = motes(data.amount);
  }
  return event;
}

/** Decode a batch, dropping anything unusable. */
export function decodeChainEvents(raw: unknown): ChainEvent[] {
  const list = Array.isArray(raw) ? raw : asRecord(raw)?.data;
  if (!Array.isArray(list)) return [];
  return list.map(decodeChainEvent).filter((e): e is ChainEvent => e !== null);
}

export interface StreamEventsOptions {
  /** Contract package hash whose events to follow (the v2 vault). */
  contractHash: string;
  /** CSPR.cloud API key. Without one the REST/SSE endpoints reject the request. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Injectable EventSource factory — Node has none, and tests need a fake. */
  eventSourceFactory?: (url: string) => EventSourceLike;
  pollIntervalMs?: number;
}

/** The slice of the EventSource API this adapter uses. */
export interface EventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export function createStreamEvents(network: CasperNetwork, opts: StreamEventsOptions): EventsPort {
  const cfg = getNetworkConfig(network);
  const base = cfg.csprCloudBaseUrl.replace(/\/+$/, "");
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

  async function fetchEvents(query: EventQuery = {}): Promise<ChainEvent[]> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const url = new URL(`${base}/contracts/${opts.contractHash}/events`);
    if (query.fromBlockHeight !== undefined) url.searchParams.set("from_block", String(query.fromBlockHeight));
    if (query.limit !== undefined) url.searchParams.set("page_size", String(query.limit));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url.toString(), {
        headers: opts.apiKey ? { authorization: opts.apiKey } : {},
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) return [];
      return decodeChainEvents(await res.json()).sort(
        (a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex,
      );
    } catch {
      return []; // an unreachable feed reads as "no new events", never as a thrown request
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    network,
    fetch: fetchEvents,

    subscribe(onEvent, onError): () => void {
      let closed = false;
      let source: EventSourceLike | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      /** Highest block height seen — the resume cursor for a poll, NOT the dedup key. */
      let watermark = 0;
      /**
       * Recently delivered events, keyed by identity.
       *
       * Deduping on block height alone does not work, and the failure is subtle: several events
       * share a block, so a strict height cursor drops legitimate siblings while an inclusive one
       * re-delivers everything at the watermark. Either way a pool ends up wrong — inflated by a
       * double-counted bet, or missing one entirely. At-least-once delivery calls for identity
       * dedup, so the key is the transaction hash plus the event's index within it.
       */
      const seen = new Set<string>();
      const seenOrder: string[] = [];
      const SEEN_LIMIT = 1_000;

      const deliver = (event: ChainEvent): void => {
        if (closed) return;
        const key = `${event.deployHash}:${event.eventIndex}`;
        if (seen.has(key)) return;
        seen.add(key);
        seenOrder.push(key);
        if (seenOrder.length > SEEN_LIMIT) {
          const evicted = seenOrder.shift();
          if (evicted) seen.delete(evicted);
        }
        watermark = Math.max(watermark, event.blockHeight);
        onEvent(event);
      };

      const startPolling = (): void => {
        if (closed || pollTimer) return;
        pollTimer = setInterval(() => {
          void fetchEvents({ fromBlockHeight: watermark }).then((events) => events.forEach(deliver));
        }, pollIntervalMs);
      };

      const factory = opts.eventSourceFactory;
      if (!factory) {
        startPolling(); // no EventSource available (server runtime) — poll, never go silent
      } else {
        try {
          const url = `${base}/contracts/${opts.contractHash}/events/stream`;
          source = factory(url);
          source.onmessage = (message) => {
            try {
              const decoded = decodeChainEvent(JSON.parse(message.data));
              if (decoded) deliver(decoded);
            } catch (err) {
              onError?.(err); // one bad frame must not tear down a healthy stream
            }
          };
          source.onerror = (err) => {
            onError?.(err);
            source?.close();
            source = null;
            startPolling(); // degrade to polling, and keep the UI moving
          };
        } catch (err) {
          onError?.(err);
          startPolling();
        }
      }

      return () => {
        closed = true;
        source?.close();
        if (pollTimer) clearInterval(pollTimer);
      };
    },
  };
}
