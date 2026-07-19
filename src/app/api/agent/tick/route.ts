/**
 * /api/agent/tick — one turn of the whole economy: Prophets bet, the Arbiter resolves every
 * matured market, boards update. This is the heartbeat that makes "the full loop runs unattended"
 * literal — a Vercel cron (GET) fires it on a schedule; the demo can also POST it by hand.
 *
 * GET  — the cron entry point (Vercel issues GET). Runs a plain tick.
 * POST — manual/demo. Optional body `{ network?, seq?, resolveSlugs?: string[] }`; `resolveSlugs`
 *        force-closes those markets this tick (the weekly meta-market close) so their settlement
 *        against the freshly-updated boards is demoable on demand.
 *
 * Auth: open in the credential-free mock/demo. In real mode it requires the cron secret — either
 * Vercel's native `Authorization: Bearer <CRON_SECRET>` or an `x-cron-secret` header — because a
 * tick moves the money path (bets + resolutions).
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { runEconomyTick } from "@/agent/economy";
import { listActions } from "@/adapters/mock/activity-log";
import { isCasperNetwork, DEFAULT_NETWORK } from "@/config/network";
import { chainMode } from "@/config/chain-mode";
import type { CasperNetwork } from "@/config/network";
import { hydrateEconomyState, persistEconomyState } from "@/adapters/persist/economy-state";

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? process.env.TICK_CRON_SECRET;
  if (chainMode() !== "real" && !secret) return true; // open in the credential-free demo
  if (!secret) return false;
  const bearer = req.headers.get("authorization");
  if (bearer === `Bearer ${secret}`) return true; // Vercel's native cron auth
  return req.headers.get("x-cron-secret") === secret;
}

async function tick(network: CasperNetwork, seq: number, resolveSlugs?: string[]): Promise<Response> {
  const report = await runEconomyTick(createContainer(network), { seq, resolveSlugs });
  // Await the KV flush: a serverless instance may freeze the moment the response returns, and the
  // cron tick is the economy's heartbeat — its bets + resolutions must land before the freeze.
  await persistEconomyState();
  return NextResponse.json({
    network,
    round: report.seq,
    placed: report.prophetActions.length,
    resolved: report.arbiterActions.length,
    prophetActions: report.prophetActions,
    arbiterActions: report.arbiterActions,
    leaderboard: report.leaderboard,
    oracleAccuracy: report.oracleBoard,
  });
}

/**
 * A real-mode tick WAITS on the chain: the agent's x402 transfer and the operator's escrow must
 * each be executed (not merely queued) before the bet counts, which is two block confirmations of
 * roughly 16s apiece, plus the Arbiter's resolutions. The platform default would cut a tick off
 * mid-settlement and leave a paid-for-nothing bet behind — the exact failure the confirmation
 * waits exist to prevent. Mock mode never gets near this.
 */
export const maxDuration = 300;

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized: the tick is gated by the cron secret" }, { status: 401 });
  }
  await hydrateEconomyState(); // tick on top of the persisted economy, not a fresh instance's seed
  const param = new URL(req.url).searchParams.get("network");
  const network = isCasperNetwork(param) ? param : DEFAULT_NETWORK;
  return tick(network, listActions().length);
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized: the tick is gated by the cron secret" }, { status: 401 });
  }
  await hydrateEconomyState(); // tick on top of the persisted economy, not a fresh instance's seed
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* body optional */
  }
  const network = isCasperNetwork(body.network) ? body.network : DEFAULT_NETWORK;
  const seq = typeof body.seq === "number" ? body.seq : listActions().length;
  const resolveSlugs = Array.isArray(body.resolveSlugs)
    ? body.resolveSlugs.filter((s): s is string => typeof s === "string")
    : undefined;
  return tick(network, seq, resolveSlugs);
}
