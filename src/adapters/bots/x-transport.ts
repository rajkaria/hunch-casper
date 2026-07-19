/**
 * Real X (Twitter) BotTransport — parses a mention webhook and (when live) replies via the v2
 * tweets API. Credential-gated exactly like Telegram (`live-gate.ts` / D2): `parseUpdate` is pure;
 * `send()` refuses without the master switch and a bearer token.
 *
 * X delivers mentions in more than one envelope depending on the product tier. We accept both the
 * v2 filtered-stream / webhook shape (`{ data: { id, text, author_id } }`) and the classic Account
 * Activity API shape (`{ tweet_create_events: [{ id_str, text, user: { id_str } }] }`), normalising
 * either to the same `InboundMessage`. Anything else parses to `null`.
 */

import type { BotTransport, InboundMessage, OutboundMessage } from "@/ports/bot-transport";
import { assertLiveSend } from "./live-gate";

interface XV2Webhook {
  data?: { id?: string; text?: string; author_id?: string };
}
interface XActivityWebhook {
  tweet_create_events?: Array<{ id_str?: string; text?: string; user?: { id_str?: string } }>;
}

const API_BASE = "https://api.twitter.com";

function fromV2(payload: XV2Webhook): InboundMessage | null {
  const d = payload.data;
  if (!d || typeof d.id !== "string" || typeof d.text !== "string" || d.text.length === 0) return null;
  return {
    platform: "x",
    mentionId: `x:${d.id}`,
    text: d.text,
    replyTo: d.id, // reply is threaded under the mention tweet
    sender: typeof d.author_id === "string" ? `x:${d.author_id}` : "x:anon",
  };
}

function fromActivity(payload: XActivityWebhook): InboundMessage | null {
  const ev = payload.tweet_create_events?.[0];
  if (!ev || typeof ev.id_str !== "string" || typeof ev.text !== "string" || ev.text.length === 0) return null;
  return {
    platform: "x",
    mentionId: `x:${ev.id_str}`,
    text: ev.text,
    replyTo: ev.id_str,
    sender: typeof ev.user?.id_str === "string" ? `x:${ev.user.id_str}` : "x:anon",
  };
}

export function createXTransport(token = process.env.X_BOT_BEARER_TOKEN): BotTransport {
  return {
    platform: "x",
    parseUpdate(payload: unknown): InboundMessage | null {
      if (typeof payload !== "object" || payload === null) return null;
      const p = payload as XV2Webhook & XActivityWebhook;
      if (p.data) return fromV2(p);
      if (p.tweet_create_events) return fromActivity(p);
      return null;
    },
    async send(message: OutboundMessage): Promise<void> {
      assertLiveSend("x", token, "X_BOT_BEARER_TOKEN");
      const body: { text: string; reply?: { in_reply_to_tweet_id: string } } = { text: message.text };
      const inReplyTo = message.inReplyToMentionId?.replace(/^x:/, "") ?? message.replyTo;
      if (inReplyTo) body.reply = { in_reply_to_tweet_id: inReplyTo };
      const res = await fetch(`${API_BASE}/2/tweets`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`x create-tweet failed: ${res.status} ${await res.text().catch(() => "")}`.trim());
      }
    },
  };
}
