/**
 * The CSPR.cloud events adapter: decoding, and the fallback.
 *
 * Decoding is pure and fixture-tested because it is the part most likely to be wrong — a field
 * renamed upstream would otherwise show up as boards that quietly stop advancing.
 *
 * The fallback gets its own attention because a subscription that silently does nothing is
 * indistinguishable from a quiet chain: no error, no events, no way to tell. Every path that
 * cannot stream must end up polling.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createStreamEvents,
  decodeChainEvent,
  decodeChainEvents,
  type EventSourceLike,
} from "@/adapters/casper/stream-events";
import type { ChainEvent } from "@/ports/events";

const VAULT = "hash-" + "ce".repeat(32);

function frame(name: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    name,
    block_height: 100,
    event_index: 0,
    deploy_hash: "ab".repeat(32),
    timestamp: "2026-07-19T00:00:00.000Z",
    data,
    ...extra,
  };
}

describe("decodeChainEvent", () => {
  it("decodes a bet", () => {
    const event = decodeChainEvent(
      frame("BetPlaced", { market_id: "m", bettor: "01aa", outcome: "yes", amount: "1000000000" }),
    );
    expect(event).toMatchObject({
      kind: "bet_placed",
      marketId: "m",
      bettor: "01aa",
      outcomeKey: "yes",
      amountMotes: "1000000000",
      blockHeight: 100,
    });
    expect(event?.timestampMs).toBe(Date.parse("2026-07-19T00:00:00.000Z"));
  });

  it("decodes a creation with its fee and outcome list", () => {
    expect(
      decodeChainEvent(
        frame("MarketCreated", { market_id: "m", fee_bps: 200, oracle: "arbiter", outcomes: ["yes", "no"] }),
      ),
    ).toMatchObject({ kind: "market_created", feeBps: 200, oracle: "arbiter", outcomeKeys: ["yes", "no"] });
  });

  it("decodes a resolution", () => {
    expect(
      decodeChainEvent(frame("MarketResolved", { market_id: "m", winning_outcome: "yes", oracle: "arbiter" })),
    ).toMatchObject({ kind: "market_resolved", outcomeKey: "yes", oracleId: "arbiter", voided: false });
  });

  it("decodes a void as a void, not as a resolution to nothing", () => {
    // Folding `MarketVoided` as "resolved to undefined" would settle winners against an empty
    // pool instead of refunding everyone.
    const event = decodeChainEvent(frame("MarketVoided", { market_id: "m" }));
    expect(event).toMatchObject({ kind: "market_resolved", voided: true });
    expect(event?.outcomeKey).toBeUndefined();
  });

  it("decodes a claim", () => {
    expect(
      decodeChainEvent(frame("PayoutClaimed", { market_id: "m", bettor: "01aa", amount: "500000000" })),
    ).toMatchObject({ kind: "payout_claimed", claimant: "01aa", amountMotes: "500000000" });
  });

  it("returns null for an unmapped contract event rather than guessing", () => {
    // The vault also emits OracleApproved / CreationOpened / BondRefunded. Accepting an unknown
    // event as a known one is how a board ends up confidently wrong.
    expect(decodeChainEvent(frame("OracleApproved", { market_id: "m" }))).toBeNull();
    expect(decodeChainEvent(frame("CreationOpened", { market_id: "m" }))).toBeNull();
  });

  it("returns null when the ordering key or market id is missing", () => {
    expect(decodeChainEvent({ name: "BetPlaced", data: { market_id: "m" } })).toBeNull();
    expect(decodeChainEvent(frame("BetPlaced", {}))).toBeNull();
  });

  it("never throws on junk", () => {
    for (const junk of [null, undefined, 42, "string", [], { name: 7 }]) {
      expect(decodeChainEvent(junk)).toBeNull();
    }
  });

  it("decodes a batch, dropping what it cannot read", () => {
    const batch = { data: [frame("BetPlaced", { market_id: "m", bettor: "a", outcome: "yes", amount: "1" }), { junk: true }] };
    expect(decodeChainEvents(batch)).toHaveLength(1);
    expect(decodeChainEvents("nonsense")).toEqual([]);
  });
});

describe("fetch", () => {
  it("reads events oldest-first and passes the API key", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/contracts/");
      expect((init?.headers as Record<string, string>)?.authorization).toBe("key-123");
      return new Response(
        JSON.stringify({
          data: [
            frame("BetPlaced", { market_id: "m", bettor: "a", outcome: "yes", amount: "1" }, { block_height: 200 }),
            frame("BetPlaced", { market_id: "m", bettor: "b", outcome: "no", amount: "1" }, { block_height: 100 }),
          ],
        }),
        { status: 200 },
      );
    });
    const port = createStreamEvents("testnet", {
      contractHash: VAULT,
      apiKey: "key-123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await port.fetch()).map((e) => e.blockHeight)).toEqual([100, 200]);
  });

  it("reads an unreachable feed as no new events, never as a thrown request", async () => {
    const port = createStreamEvents("testnet", {
      contractHash: VAULT,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(port.fetch()).resolves.toEqual([]);
  });
});

describe("subscribe — the fallback is not optional", () => {
  function fakeSource(): EventSourceLike & { emit: (e: ChainEvent | unknown) => void; fail: () => void; closed: boolean } {
    const source = {
      onmessage: null as ((e: { data: string }) => void) | null,
      onerror: null as ((e: unknown) => void) | null,
      closed: false,
      close() {
        this.closed = true;
      },
      emit(payload: unknown) {
        this.onmessage?.({ data: JSON.stringify(payload) });
      },
      fail() {
        this.onerror?.(new Error("stream dropped"));
      },
    };
    return source;
  }

  it("delivers decoded events from the stream", () => {
    const source = fakeSource();
    const port = createStreamEvents("testnet", { contractHash: VAULT, eventSourceFactory: () => source });
    const received: ChainEvent[] = [];
    const stop = port.subscribe((e) => received.push(e));
    source.emit(frame("BetPlaced", { market_id: "m", bettor: "a", outcome: "yes", amount: "1" }));
    expect(received).toHaveLength(1);
    stop();
    expect(source.closed).toBe(true);
  });

  it("survives one malformed frame without tearing down a healthy stream", () => {
    const source = fakeSource();
    const port = createStreamEvents("testnet", { contractHash: VAULT, eventSourceFactory: () => source });
    const received: ChainEvent[] = [];
    const errors: unknown[] = [];
    const stop = port.subscribe((e) => received.push(e), (err) => errors.push(err));
    source.onmessage?.({ data: "{not json" });
    source.emit(frame("BetPlaced", { market_id: "m", bettor: "a", outcome: "yes", amount: "1" }));
    expect(errors).toHaveLength(1);
    expect(received).toHaveLength(1); // the stream kept working
    stop();
  });

  it("falls back to polling when the stream drops, instead of going silent", async () => {
    vi.useFakeTimers();
    const source = fakeSource();
    let polls = 0;
    const port = createStreamEvents("testnet", {
      contractHash: VAULT,
      eventSourceFactory: () => source,
      pollIntervalMs: 10,
      fetchImpl: (async () => {
        polls += 1;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const stop = port.subscribe(() => {});
    source.fail();
    await vi.advanceTimersByTimeAsync(35);
    expect(polls).toBeGreaterThan(0);
    expect(source.closed).toBe(true);
    stop();
    vi.useRealTimers();
  });

  it("polls from the start when no EventSource exists (server runtime)", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const port = createStreamEvents("testnet", {
      contractHash: VAULT,
      pollIntervalMs: 10,
      fetchImpl: (async () => {
        polls += 1;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const stop = port.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(35);
    expect(polls).toBeGreaterThan(0);
    stop();
    vi.useRealTimers();
  });

  it("stops polling once unsubscribed", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const port = createStreamEvents("testnet", {
      contractHash: VAULT,
      pollIntervalMs: 10,
      fetchImpl: (async () => {
        polls += 1;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const stop = port.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(25);
    stop();
    const atStop = polls;
    await vi.advanceTimersByTimeAsync(50);
    expect(polls).toBe(atStop);
    vi.useRealTimers();
  });

  it("does not re-deliver an event already seen when switching to polling", async () => {
    vi.useFakeTimers();
    const source = fakeSource();
    const bet = frame("BetPlaced", { market_id: "m", bettor: "a", outcome: "yes", amount: "1" }, { block_height: 500 });
    const port = createStreamEvents("testnet", {
      contractHash: VAULT,
      eventSourceFactory: () => source,
      pollIntervalMs: 10,
      // The poll returns the same event the stream already delivered.
      fetchImpl: (async () => new Response(JSON.stringify({ data: [bet] }), { status: 200 })) as unknown as typeof fetch,
    });
    const received: ChainEvent[] = [];
    const stop = port.subscribe((e) => received.push(e));
    source.emit(bet);
    source.fail();
    await vi.advanceTimersByTimeAsync(35);
    stop();
    vi.useRealTimers();
    // Double-counting a bet would inflate a pool and corrupt every payout derived from it.
    expect(received).toHaveLength(1);
  });
});
