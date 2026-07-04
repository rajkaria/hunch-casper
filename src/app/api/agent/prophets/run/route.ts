/**
 * POST /api/agent/prophets/run — run the Prophet fleet for one round.
 *
 * The heartbeat of the live economy: a cron fires this and the four Prophets place rival bets on
 * a market, each narrating why. Open in the credential-free demo; x-cron-secret-gated in real
 * mode. Returns the round's actions (also appended to the activity feed).
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { runProphetFleet } from "@/agent/prophet";
import { listActions } from "@/adapters/mock/activity-log";
import { isCasperNetwork } from "@/config/network";
import { chainMode } from "@/config/chain-mode";

function authorized(req: Request): boolean {
  const secret = process.env.PROPHETS_CRON_SECRET;
  if (chainMode() !== "real" && !secret) return true;
  if (!secret) return false;
  return req.headers.get("x-cron-secret") === secret;
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized: the fleet is gated by x-cron-secret" }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* body optional */
  }

  const network = isCasperNetwork(body.network) ? body.network : "testnet";
  const seq = typeof body.seq === "number" ? body.seq : listActions().length;

  const actions = await runProphetFleet(createContainer(network), seq);
  return NextResponse.json({ round: seq, placed: actions.length, actions });
}
