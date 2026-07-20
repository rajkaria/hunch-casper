/**
 * Shared webhook plumbing for the chat-bot routes. Telegram and X differ only in their transport
 * and their optional shared-secret header; everything else — read body, verify secret, parse,
 * handle, always 200 — is identical, so it lives here once and the two routes are three lines each.
 *
 * Why always 200 (even on a bad body or an ignored update): a webhook that returns non-2xx is
 * retried by the platform, and a bet must not be re-attempted because our reply was slow or the
 * update wasn't a command. Idempotency (`bot-idempotency.ts`) makes a *legitimate* retry safe;
 * returning 200 for everything we can't or won't act on stops the platform retrying in the first
 * place. The one non-2xx is an auth failure on the shared secret — that we do want the platform to
 * treat as rejected.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { handleInbound } from "@/lib/bot-handler";
import { hydrateEconomyState, persistEconomyState } from "@/adapters/persist/economy-state";
import { createWebhookTransport } from "@/adapters/bots/webhook-transport";
import type { BotPlatform } from "@/ports/bot-transport";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";

interface WebhookOptions {
  /** Env var holding an optional shared secret; when set, the request must present it. */
  secretEnv: string;
  /** Header the platform echoes the shared secret in. */
  secretHeader: string;
}

const OPTIONS: Record<BotPlatform, WebhookOptions> = {
  telegram: { secretEnv: "TELEGRAM_WEBHOOK_SECRET", secretHeader: "x-telegram-bot-api-secret-token" },
  x: { secretEnv: "X_WEBHOOK_SECRET", secretHeader: "x-webhook-secret" },
};

/** Constant-time-ish secret check: only enforced when a secret is configured. */
function secretOk(req: Request, opts: WebhookOptions): boolean {
  const expected = process.env[opts.secretEnv];
  if (!expected) return true; // no secret configured → open (demo default)
  return req.headers.get(opts.secretHeader) === expected;
}

export async function handleBotWebhook(platform: BotPlatform, req: Request): Promise<Response> {
  const opts = OPTIONS[platform];
  if (!secretOk(req, opts)) {
    return NextResponse.json({ error: "invalid webhook secret" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: true, ignored: "unparseable body" }, { status: 200 });
  }

  const transport = createWebhookTransport(platform);
  const inbound = transport.parseUpdate(payload);
  if (!inbound) {
    return NextResponse.json({ ok: true, ignored: "not a command message" }, { status: 200 });
  }

  const netParam = new URL(req.url).searchParams.get("network");
  const network = isCasperNetwork(netParam) ? netParam : DEFAULT_NETWORK;
  // Bet on top of the persisted economy, and await the flush before responding — a bot bet is
  // the same money path as the REST rail, and a serverless freeze after a fire-and-forget
  // persist would drop it from the app's mirror (no-ops when KV is unconfigured).
  await hydrateEconomyState();
  const container = createContainer(network);

  const result = await handleInbound(inbound, { container, transport });
  if (result.placed) await persistEconomyState();
  return NextResponse.json(
    { ok: true, placed: result.placed, replayed: result.replayed, deployHash: result.deployHash },
    { status: 200 },
  );
}
