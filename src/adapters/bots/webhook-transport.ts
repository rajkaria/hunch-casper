/**
 * The transport the webhook *routes* use — a real transport for parsing, with a send that is safe
 * before the bots go live.
 *
 * The routes need to run the full handler (parse → dedupe → bet → reply) in every mode, including
 * the credential-free demo where nothing may be posted externally (D2). A bare real transport's
 * `send()` throws when not live, which would turn every webhook into an error. So this wrapper
 * intercepts send: when `HUNCH_BOTS_LIVE` is off it *records* the reply to an inspectable ring
 * buffer (and logs it) instead of posting; when live it delegates to the real transport and the
 * message actually goes out. Either way the handler completes and the route returns 200.
 *
 * The recorded outbox is the demo/runbook surface: an operator can POST a webhook body and read
 * back exactly what the bot would have said, with zero risk of an external post.
 */

import type { BotPlatform, BotTransport, InboundMessage, OutboundMessage } from "@/ports/bot-transport";
import { createTelegramTransport } from "./telegram-transport";
import { createXTransport } from "./x-transport";
import { botsLive } from "./live-gate";

export interface RecordedReply extends OutboundMessage {
  platform: BotPlatform;
  live: boolean;
  atMs: number;
}

const MAX_RECORDED = 50;
/** Last N replies the routes produced — most recent last. Demo/debug surface, not durable. */
export const RECORDED_REPLIES: RecordedReply[] = [];

function record(platform: BotPlatform, message: OutboundMessage, live: boolean, nowMs: number): void {
  RECORDED_REPLIES.push({ ...message, platform, live, atMs: nowMs });
  if (RECORDED_REPLIES.length > MAX_RECORDED) RECORDED_REPLIES.splice(0, RECORDED_REPLIES.length - MAX_RECORDED);
}

/** Test/demo helper: clear the recorded outbox. */
export function __resetRecordedReplies(): void {
  RECORDED_REPLIES.length = 0;
}

function baseTransportFor(platform: BotPlatform): BotTransport {
  return platform === "telegram" ? createTelegramTransport() : createXTransport();
}

/**
 * A route-safe transport for a platform: real parse, guarded send. When the bots aren't live the
 * reply is recorded and logged, never posted; when they are live it is delegated to the platform.
 */
export function createWebhookTransport(platform: BotPlatform): BotTransport {
  const base = baseTransportFor(platform);
  return {
    platform,
    parseUpdate(payload: unknown): InboundMessage | null {
      return base.parseUpdate(payload);
    },
    async send(message: OutboundMessage): Promise<void> {
      const live = botsLive();
      if (!live) {
        record(platform, message, false, Date.now());
        if (process.env.NODE_ENV !== "test") {
          console.info(`[bot:${platform}] (dry-run) → ${message.replyTo}: ${message.text.replace(/\n/g, " ⏎ ")}`);
        }
        return;
      }
      await base.send(message);
      record(platform, message, true, Date.now());
    },
  };
}
