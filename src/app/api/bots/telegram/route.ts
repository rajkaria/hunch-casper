/**
 * POST /api/bots/telegram — the Telegram webhook. Telegram POSTs an update here; the shared
 * plumbing parses it, runs the command handler (dedup by update_id, bet via x402), and replies.
 * In the demo (bots not live) the reply is recorded, not posted (decision D2). To go live, set the
 * webhook to this URL and flip `HUNCH_BOTS_LIVE=true` — see docs/OPS.md §bots.
 */

import { handleBotWebhook } from "@/lib/bot-webhook";

export async function POST(req: Request): Promise<Response> {
  return handleBotWebhook("telegram", req);
}
