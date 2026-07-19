/**
 * /api/follow — manage a copy-betting follow (S29).
 *
 * POST `{ follower, agentId, scaleBps?, perBetCapMotes?, active? }` — create/update a follow.
 * GET  `?follower=&agentId=` — read a follow's config.
 *
 * Following mirrors an agent's FUTURE positions, sized by `scaleBps` (a fraction of the agent's
 * stake) and capped per bet. Setting `active:false` unwinds the follow (no new mirrors). The
 * mirror bets themselves settle through the normal x402 money path; this route only manages the
 * follow config.
 */

import { NextResponse } from "next/server";
import { setFollow, getFollow } from "@/lib/copy-betting";

const DEFAULT_SCALE_BPS = 2_500; // mirror at 25% of the agent's size by default
const DEFAULT_CAP_MOTES = "10000000000"; // 10 CSPR per mirrored bet

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const follower = String(body.follower ?? "");
  const agentId = String(body.agentId ?? "");
  if (follower.length === 0 || agentId.length === 0) {
    return NextResponse.json({ error: "follower and agentId are required" }, { status: 400 });
  }
  const scaleBps = typeof body.scaleBps === "number" && body.scaleBps > 0 ? Math.floor(body.scaleBps) : DEFAULT_SCALE_BPS;
  const perBetCapMotes =
    typeof body.perBetCapMotes === "string" && /^\d+$/.test(body.perBetCapMotes) ? body.perBetCapMotes : DEFAULT_CAP_MOTES;
  const active = body.active !== false;

  setFollow({ follower, agentId, scaleBps, perBetCapMotes, active });
  return NextResponse.json({ follower, agentId, scaleBps, perBetCapMotes, active }, { status: 200 });
}

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const follower = params.get("follower");
  const agentId = params.get("agentId");
  if (!follower || !agentId) {
    return NextResponse.json({ error: "follower and agentId query params are required" }, { status: 400 });
  }
  const config = getFollow(follower, agentId);
  if (!config) return NextResponse.json({ following: false }, { status: 200 });
  return NextResponse.json({ following: true, config }, { status: 200 });
}
