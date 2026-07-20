/**
 * /api/agent/tick — one turn of the whole economy: Prophets bet, the Arbiter resolves every
 * matured market, boards update. This is the heartbeat that makes "the full loop runs unattended"
 * literal — a Vercel cron (GET) fires it on a schedule; the demo can also POST it by hand.
 *
 * GET  — the cron entry point (Vercel issues GET). Runs a plain tick.
 * POST — manual/demo. Optional body `{ network?, seq?, resolveSlugs?: string[], resetBreaker? }`;
 *        `resolveSlugs` force-closes those markets this tick (the weekly meta-market close) so
 *        their settlement against the freshly-updated boards is demoable on demand.
 *        `resetBreaker: true` closes a tripped paid-but-not-placed breaker — the deliberate human
 *        step after the escrow path has actually been fixed (see `agent/bet-breaker.ts`).
 *        `releaseMarkets: true | string[]` un-quarantines markets whose routing has been fixed
 *        (see `agent/market-quarantine.ts`).
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
import { persistEconomyState, rehydrateEconomyState } from "@/adapters/persist/economy-state";
import { resetBreaker } from "@/agent/bet-breaker";
import { releaseAllMarkets, releaseMarket } from "@/agent/market-quarantine";

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? process.env.TICK_CRON_SECRET;
  if (chainMode() !== "real" && !secret) return true; // open in the credential-free demo
  if (!secret) return false;
  const bearer = req.headers.get("authorization");
  if (bearer === `Bearer ${secret}`) return true; // Vercel's native cron auth
  return req.headers.get("x-cron-secret") === secret;
}

async function tick(network: CasperNetwork, seq: number, resolveSlugs?: string[]): Promise<Response> {
  let report;
  try {
    report = await runEconomyTick(createContainer(network), { seq, resolveSlugs });
  } catch (err) {
    // A tick that dies mid-flight has usually already MOVED MONEY (bets escrowed, resolutions
    // posted). Flush whatever mutated before rethrowing, or the mirror loses real transactions.
    await persistEconomyState();
    throw err;
  }
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
    // Why this tick did what it did. `placed: 0` used to be indistinguishable between "throttled
    // for lack of funds", "no market was open to bet on", and "every agent's bet failed" — three
    // problems with three different fixes, and the operator surface reported the same silence for
    // all of them. The cadence plan and the candidate count make the tick self-explaining.
    cadence: report.cadence,
    marketsConsidered: report.marketsConsidered,
    breaker: report.breaker,
    quarantined: report.quarantined,
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
  // FRESH hydrate, not the once-per-instance one: the tick persists the WHOLE envelope, so a
  // warm instance acting on a stale view would clobber every write made since it last looked.
  await rehydrateEconomyState();
  const param = new URL(req.url).searchParams.get("network");
  const network = isCasperNetwork(param) ? param : DEFAULT_NETWORK;
  return tick(network, listActions().length);
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized: the tick is gated by the cron secret" }, { status: 401 });
  }
  // FRESH hydrate, not the once-per-instance one: the tick persists the WHOLE envelope, so a
  // warm instance acting on a stale view would clobber every write made since it last looked.
  await rehydrateEconomyState();
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
  // Reset BEFORE the tick, so the same request that clears the breaker also bets again — an
  // operator who has fixed the cause should not need a second call to find out whether it worked.
  if (body.resetBreaker === true) resetBreaker();
  // Release quarantined markets once their routing is fixed: `true` for all, or a slug list.
  if (body.releaseMarkets === true) releaseAllMarkets();
  else if (Array.isArray(body.releaseMarkets)) {
    for (const slug of body.releaseMarkets) if (typeof slug === "string") releaseMarket(slug);
  }
  return tick(network, seq, resolveSlugs);
}
