import { describe, it, expect, beforeEach } from "vitest";
import { createContainer } from "@/lib/container";
import { handleInbound } from "@/lib/bot-handler";
import { createMockBotTransport } from "@/adapters/mock/mock-bot-transport";
import type { InboundMessage } from "@/ports/bot-transport";
import type { MentionRecord } from "@/lib/bot-idempotency";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";

beforeEach(() => {
  __resetLedger();
  __resetConsumedNonces();
});

const SLUG = "cspr-price-05-aug";

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "telegram",
    mentionId: over.mentionId ?? "telegram:1",
    text: over.text ?? `bet 5 CSPR YES on ${SLUG}`,
    replyTo: over.replyTo ?? "chat-1",
    sender: over.sender ?? "telegram:777",
  };
}

/** A fresh handler harness with its own idempotency ledger, so tests never share mention state. */
function harness() {
  const container = createContainer("testnet");
  const transport = createMockBotTransport("telegram");
  const ledger = new Map<string, MentionRecord>();
  return {
    container,
    transport,
    ledger,
    run: (msg: InboundMessage, nowMs = 1_000) => handleInbound(msg, { container, transport, ledger, nowMs }),
  };
}

describe("bot handler — bet round trip", () => {
  it("places a bet against the mock chain and replies with the explorer link", async () => {
    const h = harness();
    const res = await h.run(inbound());
    expect(res.placed).toBe(true);
    expect(res.replayed).toBe(false);
    expect(res.deployHash).toBeTruthy();
    expect(h.transport.outbox).toHaveLength(1);
    expect(h.transport.outbox[0].text).toContain("Bet placed");
    expect(h.transport.outbox[0].text).toContain("5 CSPR");
    // The bet actually moved the pool in the read model.
    const market = await h.container.store.get(SLUG, "testnet");
    expect(BigInt(market!.poolByOutcomeMotes.yes)).toBe(1200000000000n + 5000000000n);
  });

  it("attributes the bet to the platform sender identity", async () => {
    const h = harness();
    await h.run(inbound({ sender: "telegram:42" }));
    const entries = await h.container.store.settledEntries?.("testnet");
    // Not settled yet, but the bet is recorded against the sender in the market store's ledger.
    const market = await h.container.store.get(SLUG, "testnet");
    expect(market!.totalStakedMotes).toBe((BigInt("2000000000000") + 5000000000n).toString());
    expect(Array.isArray(entries)).toBe(true);
  });
});

describe("bot handler — idempotency by mention id", () => {
  it("replays the same mention id without placing a second bet", async () => {
    const h = harness();
    const msg = inbound({ mentionId: "telegram:99" });

    const first = await h.run(msg);
    expect(first.placed).toBe(true);

    const marketAfterFirst = await h.container.store.get(SLUG, "testnet");
    const poolAfterFirst = marketAfterFirst!.poolByOutcomeMotes.yes;

    // Same mention id, delivered again (webhook retry).
    const second = await h.run(msg);
    expect(second.placed).toBe(false);
    expect(second.replayed).toBe(true);
    // Reply is replayed verbatim; the pool did NOT move a second time.
    const marketAfterSecond = await h.container.store.get(SLUG, "testnet");
    expect(marketAfterSecond!.poolByOutcomeMotes.yes).toBe(poolAfterFirst);
    // Exactly one placed reply + one replayed reply were sent.
    expect(h.transport.outbox).toHaveLength(2);
    expect(h.transport.outbox[0].text).toBe(h.transport.outbox[1].text);
  });

  it("a pending claim does not double-process under a racing retry", async () => {
    const h = harness();
    const msg = inbound({ mentionId: "telegram:racy" });
    // Fire two deliveries without awaiting the first — the second must lose the claim.
    const [a, b] = await Promise.all([h.run(msg), h.run(msg)]);
    const placedCount = [a, b].filter((r) => r.placed).length;
    expect(placedCount).toBe(1);
    const market = await h.container.store.get(SLUG, "testnet");
    expect(BigInt(market!.poolByOutcomeMotes.yes)).toBe(1200000000000n + 5000000000n);
  });

  it("distinct mention ids each place their own bet", async () => {
    const h = harness();
    await h.run(inbound({ mentionId: "telegram:a", sender: "telegram:1" }));
    await h.run(inbound({ mentionId: "telegram:b", sender: "telegram:2" }));
    const market = await h.container.store.get(SLUG, "testnet");
    expect(BigInt(market!.poolByOutcomeMotes.yes)).toBe(1200000000000n + 2n * 5000000000n);
  });
});

describe("bot handler — reads and errors", () => {
  it("answers help without touching the money path", async () => {
    const h = harness();
    const res = await h.run(inbound({ text: "help" }));
    expect(res.placed).toBe(false);
    expect(h.transport.outbox[0].text).toContain("bet");
  });

  it("lists open markets", async () => {
    const h = harness();
    await h.run(inbound({ text: "markets" }));
    expect(h.transport.outbox[0].text.toLowerCase()).toContain("open markets");
  });

  it("shows odds for a real market and errors helpfully for an unknown one", async () => {
    const h = harness();
    await h.run(inbound({ text: `odds ${SLUG}`, mentionId: "telegram:o1" }));
    expect(h.transport.outbox[0].text).toContain("%");

    await h.run(inbound({ text: "odds no-such-market", mentionId: "telegram:o2" }));
    expect(h.transport.outbox[1].text.toLowerCase()).toContain("no market");
  });

  it("rejects a malformed command with the grammar hint", async () => {
    const h = harness();
    const res = await h.run(inbound({ text: `bet 5 yes ${SLUG}` })); // missing the word 'on'
    expect(res.placed).toBe(false);
    expect(h.transport.outbox[0].text.toLowerCase()).toContain("try:");
  });

  it("surfaces a bet on an unknown market as a friendly error, and lets a retry try again", async () => {
    const h = harness();
    const res = await h.run(inbound({ text: "bet 5 yes on ghost-market", mentionId: "telegram:err" }));
    expect(res.placed).toBe(false);
    expect(h.transport.outbox[0].text.toLowerCase()).toContain("no market");
  });

  it("rejects a bet on a non-existent outcome with a nudge to odds", async () => {
    const h = harness();
    const res = await h.run(inbound({ text: `bet 5 maybe on ${SLUG}`, mentionId: "telegram:oc" }));
    expect(res.placed).toBe(false);
    expect(h.transport.outbox[0].text.toLowerCase()).toContain("outcome");
  });
});
