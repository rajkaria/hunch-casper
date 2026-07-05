/**
 * GET /api/agent/leaderboard — the economy's two boards, computed from settled markets:
 *   • `agentPnl`  — each agent's realized PnL (the money-path numbers, not an estimate);
 *   • `oracleAccuracy` — every oracle's on-chain resolution accuracy.
 *
 * These are exactly the boards the meta-markets resolve against, and what the `/agents` dashboard
 * and the MCP `get_leaderboard` tool render. Network-scoped via `?network=` (default testnet).
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { computeAgentLeaderboard } from "@/core/agent-leaderboard";
import { isCasperNetwork, DEFAULT_NETWORK } from "@/config/network";

export async function GET(req: Request): Promise<Response> {
  const param = new URL(req.url).searchParams.get("network");
  const network = isCasperNetwork(param) ? param : DEFAULT_NETWORK;
  const container = createContainer(network);

  const agentPnl = computeAgentLeaderboard(await container.store.settledEntries(network));
  const oracleAccuracy = await container.oracle.leaderboard();

  return NextResponse.json({ network, agentPnl, oracleAccuracy });
}
