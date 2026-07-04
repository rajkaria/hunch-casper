import { describe, it, expect, beforeEach } from "vitest";
import { runProphetFleet } from "@/agent/prophet";
import { createContainer } from "@/lib/container";
import { listActions, __resetActivity } from "@/adapters/mock/activity-log";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { GET as activityGET } from "@/app/api/agent/activity/route";
import { POST as prophetsPOST } from "@/app/api/agent/prophets/run/route";

beforeEach(() => {
  __resetLedger();
  __resetConsumedNonces();
  __resetActivity();
});

describe("Prophet fleet", () => {
  it("places four narrated x402 bets on one market and logs them", async () => {
    const actions = await runProphetFleet(createContainer("testnet"), 0);
    expect(actions.length).toBe(4);
    expect(actions.every((a) => a.kind === "bet_placed")).toBe(true);
    expect(actions.every((a) => (a.narration ?? "").length > 0)).toBe(true);
    expect(actions.every((a) => a.deployHash?.length === 64)).toBe(true);
    // All four hit the same round's target market.
    expect(new Set(actions.map((a) => a.marketId)).size).toBe(1);
    expect(listActions().length).toBe(4);
  });

  it("Momentum and Contrarian take opposing sides (the rivalry)", async () => {
    const actions = await runProphetFleet(createContainer("testnet"), 0);
    const momentum = actions.find((a) => a.agent === "Momentum")!;
    const contrarian = actions.find((a) => a.agent === "Contrarian")!;
    expect(momentum.outcomeKey).not.toBe(contrarian.outcomeKey);
  });

  it("moves the pool: after the fleet, the target market has more staked than its seed", async () => {
    const container = createContainer("testnet");
    const before = await container.store.list({ network: "testnet", status: "open" });
    const target = before[0];
    await runProphetFleet(container, 0);
    const after = await container.store.get(target.slug, "testnet");
    expect(BigInt(after!.totalStakedMotes) > BigInt(target.totalStakedMotes)).toBe(true);
  });

  it("the cron route runs a round and the activity API returns the feed", async () => {
    const run = await prophetsPOST(
      new Request("http://localhost/api/agent/prophets/run", { method: "POST", body: "{}" }),
    );
    expect(run.status).toBe(200);
    expect((await run.json()).placed).toBe(4);

    const feed = await activityGET(new Request("http://localhost/api/agent/activity"));
    const json = await feed.json();
    expect(json.actions.length).toBe(4);
    expect(json.actions[0]).toHaveProperty("narration");
  });
});
