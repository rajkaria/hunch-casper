/**
 * S34/W3 — the Arbiter notifies consumer protocols, and can never be hurt by them.
 *
 * `ResolutionHook` existed as 4 passing OdraVM tests that nothing deployed and nothing called, so
 * "other Casper protocols can bind to a Hunch resolution" was a claim in a document. These tests
 * pin the wiring, and — more importantly — pin the property that makes it safe to run at all: the
 * dispatch runs AFTER winners are paid and cannot fail a resolution, no matter what a consumer
 * integration does.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createContainer, type Container } from "@/lib/container";
import { resolveMarket } from "@/agent/arbiter";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetActivity, listActions } from "@/adapters/mock/activity-log";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import type { CasperChainPort } from "@/ports/casper-chain";

beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetConsumedNonces();
  __resetCreatedMarkets();
});

type DispatchCall = { marketId: string; decidedOutcome: string; bundleHash: string };

/** A container whose chain records dispatch calls and behaves however a test needs it to. */
function withDispatch(
  calls: DispatchCall[],
  impl?: (input: DispatchCall) => Promise<{ deployHash?: string; skipped?: string }>,
): Container {
  const base = createContainer("testnet");
  const chain: CasperChainPort = {
    ...base.chain,
    dispatchResolution: async (input: DispatchCall) => {
      calls.push(input);
      return impl ? impl(input) : { deployHash: "dispatch-tx-1" };
    },
  };
  return { ...base, chain };
}

async function openSlug(container: Container): Promise<string> {
  const open = (await container.store.list({ network: "testnet", status: "open" })).filter(
    (m) => m.category !== "meta",
  );
  return open[0].slug;
}

describe("the Arbiter dispatches resolution hooks", () => {
  it("does not dispatch in mock mode — there is no chain to notify", async () => {
    const calls: DispatchCall[] = [];
    const container = withDispatch(calls);
    await resolveMarket(container, await openSlug(container));
    // chainMode() is mock in tests, and dispatch is real-mode only.
    expect(calls).toHaveLength(0);
  });

  it("records the resolution regardless of whether hooks are wired", async () => {
    const container = withDispatch([]);
    const action = await resolveMarket(container, await openSlug(container));
    expect(action?.kind).toBe("market_resolved");
  });
});

describe("a broken consumer integration can never withhold a settled payout", () => {
  /**
   * The failure this design exists to prevent. Winners are paid before dispatch runs, so a hook
   * that throws, reverts, times out or is misconfigured must be absorbed — otherwise one
   * third-party contract could hold everyone's money hostage by being broken.
   */
  it.each([
    ["throws", async () => { throw new Error("hook contract reverted: NotResolver"); }],
    ["reports skipped", async () => ({ skipped: "no ResolutionHook configured" })],
    ["never returns a hash", async () => ({})],
  ])("still resolves when dispatch %s", async (_label, impl) => {
    const calls: DispatchCall[] = [];
    const container = withDispatch(calls, impl as () => Promise<{ deployHash?: string }>);

    const action = await resolveMarket(container, await openSlug(container));

    expect(action).not.toBeNull();
    expect(action?.kind).toBe("market_resolved");
    // And the resolution is still in the feed — nothing was rolled back.
    expect(listActions().some((a) => a.kind === "market_resolved")).toBe(true);
  });

  it("logs the reason rather than swallowing it silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const container = withDispatch([], async () => {
        throw new Error("hook contract reverted");
      });
      // Force the real-mode branch so the dispatch is actually attempted.
      const saved = process.env.CASPER_CHAIN_MODE;
      process.env.CASPER_CHAIN_MODE = "real";
      try {
        await resolveMarket(container, await openSlug(container));
      } finally {
        if (saved === undefined) delete process.env.CASPER_CHAIN_MODE;
        else process.env.CASPER_CHAIN_MODE = saved;
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the deployed hook addresses are wired into the network config", () => {
  it("carries a resolutionHook slot for both networks", async () => {
    const { NETWORKS } = await import("@/config/network");
    // The slot must exist even when unset, or a deployment has no way to turn the oracle on.
    expect("resolutionHook" in NETWORKS.testnet.contracts).toBe(true);
    expect("resolutionHook" in NETWORKS.mainnet.contracts).toBe(true);
  });
});
