import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveMarket, runArbiterSweep } from "@/agent/arbiter";
import { createContainer } from "@/lib/container";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { POST as arbiterPOST } from "@/app/api/agent/arbiter/run/route";

beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetConsumedNonces();
  __resetCreatedMarkets();
});

function post(body: unknown): Request {
  return new Request("http://localhost/api/agent/arbiter/run", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("Arbiter — resolving an external market", () => {
  it("resolves a market, settles it, logs a narrated action, and updates its reputation", async () => {
    const container = createContainer("testnet");
    const before = await container.oracle.reputationOf("arbiter");

    const action = await resolveMarket(container, "cspr-price-05-aug");
    expect(action).not.toBeNull();
    expect(action!.kind).toBe("market_resolved");
    expect(action!.agent).toBe("Arbiter");
    expect((action!.narration ?? "").length).toBeGreaterThan(0);
    expect(action!.deployHash?.length).toBe(64); // real on-chain resolve tx

    // Settlement recorded off-chain.
    const settlement = await container.store.settlementFor("testnet:cspr-price-05-aug");
    expect(settlement).not.toBeNull();
    expect(settlement!.winningOutcomeKey).toBe(action!.outcomeKey);

    // Reputation moved: one more resolution than the seeded baseline.
    const after = await container.oracle.reputationOf("arbiter");
    expect(after.resolvedCount).toBe(before.resolvedCount + 1);
  });

  it("is idempotent — a second resolution of the same market is a no-op", async () => {
    const container = createContainer("testnet");
    const first = await resolveMarket(container, "cspr-price-05-aug");
    expect(first).not.toBeNull();
    const second = await resolveMarket(container, "cspr-price-05-aug");
    expect(second).toBeNull();
  });

  it("returns null for an unknown market", async () => {
    expect(await resolveMarket(createContainer("testnet"), "not-a-market")).toBeNull();
  });
});

describe("Arbiter — the unattended sweep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves only matured (past-deadline) markets and leaves future ones open", async () => {
    // Freeze after the Aug-1 catalogue deadlines but before the Aug-3 meta-market deadlines.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));

    const container = createContainer("testnet");
    const actions = await runArbiterSweep(container);

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.kind === "market_resolved")).toBe(true);

    // The weekly meta-market (deadline Aug 3) is NOT swept — Prophets can still bet it.
    expect(await container.store.settlementFor("testnet:prophet-race-weekly")).toBeNull();

    // A second sweep finds nothing new (idempotent).
    expect((await runArbiterSweep(container)).length).toBe(0);
  });
});

describe("POST /api/agent/arbiter/run", () => {
  it("resolves an explicit market by slug, then reports 0 on a repeat (already settled)", async () => {
    const first = await arbiterPOST(post({ network: "testnet", slug: "cspr-price-05-aug" }));
    const firstJson = await first.json();
    expect(first.status).toBe(200);
    expect(firstJson.resolved).toBe(1);
    expect(firstJson.actions[0].agent).toBe("Arbiter");

    const second = await arbiterPOST(post({ network: "testnet", slug: "cspr-price-05-aug" }));
    expect((await second.json()).resolved).toBe(0);
  });

  it("sweeps when no target is given (nothing matured now → 0 resolved)", async () => {
    const res = await arbiterPOST(post({ network: "testnet" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.resolved).toBe(0); // seed deadlines are in the future
  });
});

describe("Arbiter sweep — fault isolation (one bad market must not kill the tick)", () => {
  function withChain(overrides: Partial<ReturnType<typeof createContainer>["chain"]>) {
    const base = createContainer("testnet");
    return { ...base, chain: { ...base.chain, ...overrides } };
  }

  it("a market whose on-chain resolve reverts is skipped and retried, not fatal", async () => {
    // Freeze past the catalogue deadlines so the sweep actually reaches the chain call.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
    try {
      const boom = vi
        .fn()
        .mockRejectedValue(new Error("transaction reverted: User error: 1 (NotOracle)"));
      const container = withChain({ resolveMarket: boom });

      // The sweep must complete without throwing even though every chain resolve fails…
      const actions = await runArbiterSweep(container);
      expect(boom).toHaveBeenCalled();
      expect(actions.length).toBe(0);

      // …and nothing may be settled off-chain for a market the chain refused: the mirror
      // would claim a resolution the vault never made, and the retry next tick would stop.
      const settlement = await container.store.settlementFor("testnet:cspr-price-05-aug");
      expect(settlement).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a chain that already settled the market reconciles the mirror instead of retrying forever", async () => {
    const already = vi
      .fn()
      .mockRejectedValue(new Error("transaction reverted: User error: 5 (AlreadySettled)"));
    const container = withChain({ resolveMarket: already });

    const action = await resolveMarket(container, "cspr-price-05-aug");
    // Settled off-chain by the recipe's answer, with no new transaction to point at.
    expect(action).not.toBeNull();
    expect(action?.deployHash).toBeUndefined();
    const settlement = await container.store.settlementFor("testnet:cspr-price-05-aug");
    expect(settlement).not.toBeNull();
  });
});
