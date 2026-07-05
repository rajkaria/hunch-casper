/**
 * Feed honesty: every activity item must say whether its deploy hash is a real on-chain
 * transaction or a simulated (mock-chain / demo-seed) one, so the UI never links a judge to a
 * cspr.live "transaction not found" page for a pseudo hash. In mock chain mode (the default,
 * credential-free demo) every produced action is `simulated: true`; the flag flips off only when
 * the real adapter mints the hash.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runProphetFleet } from "@/agent/prophet";
import { resolveMarket } from "@/agent/arbiter";
import { runGenesis } from "@/agent/genesis";
import { createContainer } from "@/lib/container";
import { listActions, __resetActivity } from "@/adapters/mock/activity-log";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { ensureDemoSeed, __resetDemoSeed } from "@/adapters/mock/demo-seed";

beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetCreatedMarkets();
  __resetConsumedNonces();
  __resetDemoSeed();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("activity feed simulated flag", () => {
  it("Prophet bets in mock chain mode are marked simulated", async () => {
    const actions = await runProphetFleet(createContainer("testnet"), 0);
    expect(actions.length).toBe(4);
    expect(actions.every((a) => a.simulated === true)).toBe(true);
  });

  it("Arbiter resolutions in mock chain mode are marked simulated", async () => {
    const container = createContainer("testnet");
    const open = await container.store.list({ network: "testnet", status: "open" });
    const action = await resolveMarket(container, open[0].slug);
    expect(action).not.toBeNull();
    expect(action!.simulated).toBe(true);
  });

  it("Genesis creations are marked simulated until a real MarketFactory tx backs them", async () => {
    const market = await runGenesis(createContainer("testnet"), {
      metric: "cspr_usd",
      value: "0.05",
      unitLabel: "$",
      deadlineIso: new Date(Date.now() + 3_600_000).toISOString(),
      seq: 0,
    });
    expect(market.slug).toBe("genesis-cspr-usd-0");
    const created = listActions().find((a) => a.kind === "market_created");
    expect(created?.simulated).toBe(true);
  });

  it("demo-seed history is always simulated", () => {
    vi.stubEnv("NODE_ENV", "development");
    ensureDemoSeed("testnet");
    const actions = listActions();
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.simulated === true)).toBe(true);
  });
});
