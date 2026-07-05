import { describe, it, expect, beforeEach } from "vitest";
import { runGenesis, definitionFromTrigger } from "@/agent/genesis";
import type { GenesisTrigger } from "@/agent/genesis";
import { createContainer } from "@/lib/container";
import { buildDeployPlan } from "@/core/market-generator";
import { findDefinition, __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { POST as genesisPOST } from "@/app/api/agent/genesis/run/route";
import { POST as mcpPOST } from "@/app/api/mcp/route";

beforeEach(() => {
  __resetCreatedMarkets();
  __resetLedger();
});

const trigger: GenesisTrigger = {
  metric: "cspr_usd",
  value: "0.05",
  unitLabel: "$",
  deadlineIso: "2026-12-01T00:00:00.000Z",
  seq: 0,
};

describe("Genesis market maker", () => {
  it("builds a deterministic, ABI-valid definition from a trigger", () => {
    const def = definitionFromTrigger(trigger, "framing copy");
    expect(def.slug).toBe("genesis-cspr-usd-0");
    expect(def.resolver.target).toBe("0.0550"); // 0.05 * 1.1
    expect(def.resolver.comparator).toBe("gte");
    expect(() => buildDeployPlan(def)).not.toThrow();
    // Deterministic.
    expect(definitionFromTrigger(trigger, "framing copy")).toEqual(def);
  });

  it("rotates through ≥2 distinct market shapes (direction varies, not just the metric)", () => {
    const shapes = [0, 1, 2, 3].map((seq) => {
      const def = definitionFromTrigger({ ...trigger, seq }, "");
      return def.resolver.comparator;
    });
    // At least one "hold/break above" (gte) and one "fall/dip below" (lte) — Genesis isn't templated.
    expect(shapes).toContain("gte");
    expect(shapes).toContain("lte");
    expect(new Set(shapes).size).toBeGreaterThanOrEqual(2);
  });

  it("creates a market that is instantly live in the store and bettable", async () => {
    const container = createContainer("testnet");
    const market = await runGenesis(container, trigger);
    expect(market.slug).toBe("genesis-cspr-usd-0");
    expect(findDefinition("genesis-cspr-usd-0")).toBeDefined();

    const list = await container.store.list({ network: "testnet" });
    expect(list.some((m) => m.slug === market.slug)).toBe(true);

    const updated = await container.store.recordBet({
      marketId: market.id,
      bettor: "agent:momentum",
      outcomeKey: "yes",
      amountMotes: "1000000000",
    });
    expect(BigInt(updated.poolByOutcomeMotes.yes) > 500000000000n).toBe(true);
  });

  it("refuses to create the same market twice (slug collision)", async () => {
    const container = createContainer("testnet");
    await runGenesis(container, trigger);
    await expect(runGenesis(container, trigger)).rejects.toThrow(/already exists/);
  });

  it("appears in the MCP list_markets tool once created", async () => {
    await runGenesis(createContainer("testnet"), trigger);
    const res = await mcpPOST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_markets", arguments: { network: "testnet" } },
        }),
      }),
    );
    const data = JSON.parse((await res.json()).result.content[0].text);
    expect(data.markets.some((m: { slug: string }) => m.slug === "genesis-cspr-usd-0")).toBe(true);
  });

  it("the cron route creates a market from the rotating mock signal", async () => {
    const res = await genesisPOST(
      new Request("http://localhost/api/agent/genesis/run", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.created.slug).toBe("genesis-cspr-usd-0"); // seq 0 → first signal
    expect(json.created.category).toBe("casper-native");
  });
});
