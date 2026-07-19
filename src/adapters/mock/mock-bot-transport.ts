/**
 * Mock BotTransport — the credential-free implementation that CI, the local polling driver, and
 * every handler test run against. It parses a trivial JSON envelope (already normalised, so tests
 * express intent directly) and records every reply in an in-memory outbox instead of posting it.
 *
 * A single mock backs both platforms: pass the platform in. The parse shape is intentionally the
 * lowest common denominator — `{ mentionId, text, replyTo?, sender? }` — because the point of the
 * mock is to exercise the *handler*, not to re-simulate Telegram's or X's envelope (the real
 * transports own that, with their own tests).
 */

import type { BotPlatform, BotTransport, InboundMessage, OutboundMessage } from "@/ports/bot-transport";

export interface MockBotTransport extends BotTransport {
  /** Every reply `send()` was asked to deliver, in order — the test assertion surface. */
  readonly outbox: OutboundMessage[];
  /** Forget all recorded replies. */
  reset(): void;
}

function normaliseId(platform: BotPlatform, raw: unknown): string | null {
  if (typeof raw === "string" && raw.length > 0) {
    return raw.startsWith(`${platform}:`) ? raw : `${platform}:${raw}`;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return `${platform}:${raw}`;
  return null;
}

export function createMockBotTransport(platform: BotPlatform): MockBotTransport {
  const outbox: OutboundMessage[] = [];

  return {
    platform,
    outbox,
    reset() {
      outbox.length = 0;
    },
    parseUpdate(payload: unknown): InboundMessage | null {
      if (typeof payload !== "object" || payload === null) return null;
      const p = payload as Record<string, unknown>;
      const mentionId = normaliseId(platform, p.mentionId ?? p.id);
      if (mentionId === null) return null;
      if (typeof p.text !== "string") return null;
      const replyTo = typeof p.replyTo === "string" && p.replyTo.length > 0 ? p.replyTo : mentionId;
      const senderRaw = normaliseId(platform, p.sender);
      const sender = senderRaw ?? `${platform}:anon`;
      return { platform, mentionId, text: p.text, replyTo, sender };
    },
    async send(message: OutboundMessage): Promise<void> {
      outbox.push(message);
    },
  };
}
