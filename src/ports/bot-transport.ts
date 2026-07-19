/**
 * BotTransport — the seam between a chat platform and the bot's command logic.
 *
 * Everything platform-specific lives behind this port: how Telegram frames a webhook update vs.
 * how X frames a mention, and how a reply is delivered. The handler in `lib/bot-handler.ts`
 * receives a normalised `InboundMessage` and produces text; the route uses a transport to turn a
 * raw webhook body into that message and to send the reply back. That indirection is what lets the
 * whole handler — parse, dedupe, bet, reply — be tested against a mock transport with no live
 * token, no network, and no external post (decision D2: this run builds the bots, it does not run
 * them).
 *
 * Implementations:
 *  - `adapters/mock/mock-bot-transport.ts` — records sends, parses a trivial `{mentionId,text,…}`
 *    envelope; the test + local-polling driver.
 *  - `adapters/bots/telegram-transport.ts` — real Telegram Bot API shape + `sendMessage`.
 *  - `adapters/bots/x-transport.ts` — real X mention shape + reply.
 *
 * The two real transports are credential- and flag-gated: without a token they parse updates but
 * `send()` refuses, so importing them can never accidentally post in the user's name.
 */

export type BotPlatform = "telegram" | "x";

/** A user message, normalised out of a platform webhook. */
export interface InboundMessage {
  platform: BotPlatform;
  /**
   * The platform's stable id for this message — Telegram's `update_id`, X's mention/tweet id.
   * This is the idempotency key: a webhook that is retried delivers the same id, and the handler
   * must place at most one bet for it. Prefixed with the platform so ids never collide across
   * surfaces (`telegram:4210`, `x:1780000000000000000`).
   */
  mentionId: string;
  /** The raw text the user typed, platform decoration and all — the parser strips what it must. */
  text: string;
  /**
   * Opaque reply target the transport understands: a Telegram chat id, or an X tweet id to reply
   * under. The handler treats it as a token to hand back to `send()`, never inspects it.
   */
  replyTo: string;
  /**
   * The bettor's ledger identity — `telegram:<userId>` / `x:<userId>`. Stable per user so a
   * person's bets from chat accrue to one account. Never a raw display name (those are mutable and
   * collide); always the platform's numeric user id.
   */
  sender: string;
}

/** A reply to deliver. */
export interface OutboundMessage {
  /** The `replyTo` token from the inbound message this answers. */
  replyTo: string;
  text: string;
  /** X threads replies under the mention; carried through so the real adapter can set it. */
  inReplyToMentionId?: string;
}

export interface BotTransport {
  platform: BotPlatform;
  /**
   * Turn a raw webhook body into an inbound message, or `null` when the payload is not a user
   * message this bot acts on (edits, joins, non-mentions, malformed bodies). Returning `null`
   * rather than throwing keeps the route's contract simple: a webhook always gets a 200 so the
   * platform stops retrying, even when there was nothing to do.
   */
  parseUpdate(payload: unknown): InboundMessage | null;
  /**
   * Deliver a reply. The mock records it; a real transport calls the platform API. A transport
   * that is present but not authorised for live sending must reject (never silently succeed), so a
   * misconfigured deployment fails loudly instead of dropping replies.
   */
  send(message: OutboundMessage): Promise<void>;
}
