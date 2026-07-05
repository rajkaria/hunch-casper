import { describe, it, expect, beforeEach } from "vitest";
import { createContainer } from "@/lib/container";
import { runProphetFleet } from "@/agent/prophet";
import { resolveMarket } from "@/agent/arbiter";
import { GET as leaderboardGET } from "@/app/api/agent/leaderboard/route";
import { callTool } from "@/lib/mcp";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";

beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetConsumedNonces();
  __resetCreatedMarkets();
});

async function seedOneSettledMarket() {
  const container = createContainer("testnet");
  const open = (await container.store.list({ network: "testnet", status: "open" })).filter(
    (m) => m.category !== "meta",
  );
  await runProphetFleet(container, 0);
  await resolveMarket(container, open[0].slug);
}

describe("GET /api/agent/leaderboard", () => {
  it("always exposes the oracle-accuracy board (Arbiter present even before any resolution)", async () => {
    const res = await leaderboardGET(new Request("http://localhost/api/agent/leaderboard?network=testnet"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.network).toBe("testnet");
    expect(json.agentPnl).toEqual([]);
    expect(json.oracleAccuracy.some((o: { oracleId: string }) => o.oracleId === "arbiter")).toBe(true);
  });

  it("fills the agent PnL board after markets settle", async () => {
    await seedOneSettledMarket();
    const res = await leaderboardGET(new Request("http://localhost/api/agent/leaderboard?network=testnet"));
    const json = await res.json();
    expect(json.agentPnl.length).toBe(4);
    // Sorted best-first: PnL is non-increasing down the board.
    for (let i = 1; i < json.agentPnl.length; i++) {
      expect(BigInt(json.agentPnl[i - 1].realizedPnlMotes) >= BigInt(json.agentPnl[i].realizedPnlMotes)).toBe(true);
    }
  });
});

describe("MCP get_leaderboard", () => {
  it("returns the real agent PnL + oracle-accuracy boards", async () => {
    await seedOneSettledMarket();
    const result = await callTool("get_leaderboard", { network: "testnet" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      agentPnl: { agent: string }[];
      oracleAccuracy: { oracleId: string }[];
    };
    expect(data.agentPnl.length).toBe(4);
    expect(data.oracleAccuracy.some((o) => o.oracleId === "arbiter")).toBe(true);
  });
});
