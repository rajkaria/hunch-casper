/**
 * GET /api/health — one JSON an operator, an uptime monitor, or a judge can poll to learn
 * exactly how this deployment is wired and whether it is actually doing its job.
 *
 * Answers the questions that used to require reading four dashboards: is this instance in real
 * or mock mode, do bets have somewhere on-chain to go, is KV reachable *right now* (not merely
 * configured), can the scheduled tick authenticate, and when did an agent last act.
 *
 * Status codes are monitor-friendly: `200` when every check passes or only warns, `503` when any
 * check fails — so an uptime probe needs no body parsing to page someone. `?network=` selects
 * the network (default testnet).
 *
 * Unauthenticated by design, and safe to be: the report contains booleans and already-public
 * contract hashes, never a secret's value (see `src/lib/health.ts`).
 */

import { NextResponse } from "next/server";
import { gatherHealth } from "@/lib/health";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";

/** Health must reflect this instance right now — never a cached render. */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const param = new URL(req.url).searchParams.get("network");
  const network = isCasperNetwork(param) ? param : DEFAULT_NETWORK;
  const report = await gatherHealth(network);
  return NextResponse.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
