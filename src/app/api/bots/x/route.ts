/**
 * POST /api/bots/x — the X (Twitter) mention webhook. X POSTs a mention here; the shared plumbing
 * parses it, runs the command handler (dedup by tweet id, bet via x402), and replies under the
 * mention. In the demo (bots not live) the reply is recorded, not posted (decision D2). To go live,
 * register this URL as the mention webhook and flip `HUNCH_BOTS_LIVE=true` — see docs/OPS.md §bots.
 *
 * GET is the CRC/challenge handshake some X webhook tiers require to verify the endpoint: echo the
 * `crc_token` back. Harmless when unused.
 */

import { NextResponse } from "next/server";
import { handleBotWebhook } from "@/lib/bot-webhook";

export async function POST(req: Request): Promise<Response> {
  return handleBotWebhook("x", req);
}

export async function GET(req: Request): Promise<Response> {
  const crc = new URL(req.url).searchParams.get("crc_token");
  if (crc) return NextResponse.json({ response_token: `sha256=${crc}` }, { status: 200 });
  return NextResponse.json({ ok: true, endpoint: "x-mention-webhook" }, { status: 200 });
}
