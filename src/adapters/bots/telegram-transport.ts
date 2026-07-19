/**
 * Real Telegram BotTransport — parses a Telegram webhook update and (when live) replies via the
 * Bot API. Credential-gated: `send()` refuses unless the master switch is on and a token is set
 * (see `live-gate.ts` / decision D2). `parseUpdate` is pure and always available, which is what
 * the route tests exercise.
 *
 * Update shape (Bot API `getUpdates` / webhook): `{ update_id, message: { message_id, from: {id},
 * chat: {id}, text } }`. We act only on text messages; edits, joins, and non-text updates parse to
 * `null` so the route 200s and Telegram stops retrying.
 */

import type { BotTransport, InboundMessage, OutboundMessage } from "@/ports/bot-transport";
import { assertLiveSend } from "./live-gate";

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    from?: { id?: number };
    chat?: { id?: number | string };
    text?: string;
  };
}

const API_BASE = "https://api.telegram.org";

export function createTelegramTransport(token = process.env.TELEGRAM_BOT_TOKEN): BotTransport {
  return {
    platform: "telegram",
    parseUpdate(payload: unknown): InboundMessage | null {
      if (typeof payload !== "object" || payload === null) return null;
      const update = payload as TelegramUpdate;
      const msg = update.message;
      if (!msg || typeof msg.text !== "string" || msg.text.length === 0) return null;
      if (typeof update.update_id !== "number") return null;
      const chatId = msg.chat?.id;
      if (chatId === undefined || chatId === null) return null;
      const fromId = msg.from?.id;
      return {
        platform: "telegram",
        // update_id is unique and monotonic per bot — the natural idempotency key.
        mentionId: `telegram:${update.update_id}`,
        text: msg.text,
        replyTo: String(chatId),
        sender: fromId !== undefined ? `telegram:${fromId}` : "telegram:anon",
      };
    },
    async send(message: OutboundMessage): Promise<void> {
      assertLiveSend("telegram", token, "TELEGRAM_BOT_TOKEN");
      const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: message.replyTo,
          text: message.text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        throw new Error(`telegram sendMessage failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
      }
    },
  };
}
