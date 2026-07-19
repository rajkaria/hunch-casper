/**
 * The bot command handler — one inbound chat message in, one reply out, at most one bet placed.
 *
 * This is where the pieces meet: the pure grammar (`core/bot-command.ts`) decides what the user
 * meant, the mention-id guard (`bot-idempotency.ts`) ensures a retried webhook is answered once,
 * and the same x402 money path the REST/MCP rails use (`agentBet`) places the bet. The route layer
 * (`/api/bots/*`) does nothing but turn a webhook body into an `InboundMessage` via a transport and
 * hand it here — so the entire behaviour is testable against mock adapters with no token, no
 * network, and no external post (decision D2).
 *
 * The bettor identity is the platform user id (`telegram:<id>` / `x:<id>`), so a person's chat bets
 * accrue to one stable ledger account across messages.
 */

import type { Container } from "@/lib/container";
import type { BotTransport, InboundMessage } from "@/ports/bot-transport";
import { agentBet } from "@/lib/agent-bet";
import {
  claimMention,
  finalizeMention,
  releaseMention,
  type MentionRecord,
} from "@/lib/bot-idempotency";
import {
  parseBotCommand,
  helpText,
  DEFAULT_MARKET_LIST,
  type BotCommand,
} from "@/core/bot-command";
import { computeOdds, formatProbability } from "@/core/parimutuel-odds";
import { motesToCspr, type Market } from "@/core/types";
import { marketUrl } from "@/config/site";

export interface BotHandlerDeps {
  container: Container;
  transport: BotTransport;
  /** Milliseconds since epoch — injected so tests are deterministic. Defaults to `Date.now()`. */
  nowMs?: number;
  /** Idempotency ledger override for tests; defaults to the module singleton inside the guard. */
  ledger?: Map<string, MentionRecord>;
}

export interface BotHandleResult {
  /** The reply text that was sent (or replayed). */
  reply: string;
  /** Whether this delivery placed a bet (false for replays, reads, help, and errors). */
  placed: boolean;
  /** True when this delivery was a retry answered from the idempotency ledger. */
  replayed: boolean;
  /** The bet's settlement hash, when one was placed or replayed. */
  deployHash?: string;
}

/**
 * Process one inbound message end to end: dedupe, parse, dispatch, reply. Always sends exactly one
 * reply through the transport (the fresh reply, or the replayed one), so the caller can return 200
 * unconditionally and the platform stops retrying.
 */
export async function handleInbound(msg: InboundMessage, deps: BotHandlerDeps): Promise<BotHandleResult> {
  const { container, transport } = deps;
  const nowMs = deps.nowMs ?? Date.now();

  // Front gate: claim the mention id before touching anything. A retry loses the claim and is
  // answered from the ledger — never re-run through the money path.
  const claim = claimMention(msg.mentionId, nowMs, deps.ledger);
  if (!claim.fresh) {
    const record = claim.record;
    if (record.status === "pending") {
      // The winner is still working. Reply nothing new and place nothing — do NOT send a second
      // message that could race the winner's reply.
      return { reply: "", placed: false, replayed: true, deployHash: record.deployHash };
    }
    const reply = record.reply ?? "";
    await transport.send({ replyTo: msg.replyTo, text: reply, inReplyToMentionId: msg.mentionId });
    return { reply, placed: false, replayed: true, deployHash: record.deployHash };
  }

  let placedHash: string | undefined;
  let reply: string;
  try {
    const parsed = parseBotCommand(msg.text);
    if (!parsed.ok) {
      reply = `${parsed.error}\n${parsed.hint}`;
    } else {
      const dispatched = await dispatch(parsed.command, msg, container);
      reply = dispatched.reply;
      placedHash = dispatched.deployHash;
    }
  } catch (err) {
    // A throw *before* a bet was placed means the money path was never touched — release the
    // claim so a retry can try again rather than being stuck with an error forever. A throw after
    // placement can't reach here: dispatch() finalizes its own success before returning.
    releaseMention(msg.mentionId, deps.ledger);
    const reason = err instanceof Error ? err.message : "unexpected error";
    const errorReply = `couldn't process that: ${reason}`;
    await transport.send({ replyTo: msg.replyTo, text: errorReply, inReplyToMentionId: msg.mentionId });
    return { reply: errorReply, placed: false, replayed: false };
  }

  finalizeMention(msg.mentionId, { reply, deployHash: placedHash }, deps.ledger);
  await transport.send({ replyTo: msg.replyTo, text: reply, inReplyToMentionId: msg.mentionId });
  return { reply, placed: placedHash !== undefined, replayed: false, deployHash: placedHash };
}

async function dispatch(
  command: BotCommand,
  msg: InboundMessage,
  container: Container,
): Promise<{ reply: string; deployHash?: string }> {
  switch (command.kind) {
    case "help":
      return { reply: helpText() };
    case "markets":
      return { reply: await renderMarketList(container, command.limit) };
    case "odds":
      return { reply: await renderOdds(container, command.slug) };
    case "bet":
      return placeBet(command, msg, container);
  }
}

async function renderMarketList(container: Container, limit: number): Promise<string> {
  const open = (await container.store.list({ network: container.network, status: "open" })).slice(0, limit);
  if (open.length === 0) return "no markets are open right now — check back after the next round.";
  const lines = open.map((m) => `• \`${m.slug}\` — ${m.title}${topOutcomeSuffix(m)}`);
  const more = limit === DEFAULT_MARKET_LIST ? "\n\n`odds <slug>` for detail · `bet 5 CSPR YES on <slug>` to play" : "";
  return `Open markets (${open.length}):\n${lines.join("\n")}${more}`;
}

async function renderOdds(container: Container, slug: string): Promise<string> {
  const market = await container.store.get(slug, container.network);
  if (!market) return `no market \`${slug}\` on ${container.network}. try \`markets\` to see what's open.`;
  const odds = computeOdds(market);
  const rows = odds.map((o) => {
    const outcome = market.outcomes.find((x) => x.key === o.outcomeKey);
    const label = outcome ? outcome.label : o.outcomeKey;
    const mult = o.payoutMultiple > 0 ? ` (${o.payoutMultiple.toFixed(2)}×)` : "";
    return `• ${label}: ${formatProbability(o.impliedProbability)}${mult}`;
  });
  const pool = motesToCspr(market.totalStakedMotes);
  const status = market.status === "open" ? "" : ` — ${market.status}`;
  return [
    `*${market.title}*${status}`,
    ...rows,
    `pool: ${formatCspr(pool)} CSPR · ${marketUrl(market.slug)}`,
  ].join("\n");
}

async function placeBet(
  command: Extract<BotCommand, { kind: "bet" }>,
  msg: InboundMessage,
  container: Container,
): Promise<{ reply: string; deployHash?: string }> {
  const marketId = `${container.network}:${command.slug}`;

  // x402 handshake, exactly as an agent would run it: the no-proof call validates the bet and
  // returns the challenge; the bot pays it on the user's behalf; the second call escrows.
  const challenge = await agentBet(container, {
    marketId,
    outcomeKey: command.outcomeKey,
    amountMotes: command.amountMotes,
    bettor: msg.sender,
  });
  if (challenge.status === "error") {
    return { reply: betError(command, challenge.error) };
  }
  if (challenge.status !== "payment_required") {
    return { reply: "unexpected bet state — please try again." };
  }

  const proof = await container.payment.settle(challenge.requirement, msg.sender);
  const placed = await agentBet(container, {
    marketId,
    outcomeKey: command.outcomeKey,
    amountMotes: command.amountMotes,
    bettor: msg.sender,
    paymentProof: proof,
  });

  if (placed.status === "error") return { reply: betError(command, placed.error) };
  if (placed.status !== "placed") return { reply: "bet did not go through — please try again." };

  const outcomeLabel = await outcomeLabelFor(container, command.slug, command.outcomeKey);
  const previewCspr = formatCspr(motesToCspr(challenge.previewPayoutMotes));
  const lines = [
    `✅ Bet placed: ${command.amountCspr} CSPR on ${outcomeLabel} in \`${command.slug}\`.`,
    `if it wins you collect ~${previewCspr} CSPR.`,
    placed.explorerUrl,
  ];
  return { reply: lines.join("\n"), deployHash: placed.deployHash };
}

/** Turn a raw agentBet error into a chat-friendly line with a nudge back to the grammar. */
function betError(command: Extract<BotCommand, { kind: "bet" }>, error: string): string {
  if (error.startsWith("unknown market")) {
    return `no market \`${command.slug}\`. try \`markets\` to see what's open.`;
  }
  if (error.includes("is not an outcome")) {
    return `\`${command.outcomeKey}\` isn't an outcome of \`${command.slug}\`. try \`odds ${command.slug}\` to see the outcomes.`;
  }
  return `couldn't place that bet: ${error}`;
}

async function outcomeLabelFor(container: Container, slug: string, outcomeKey: string): Promise<string> {
  const market = await container.store.get(slug, container.network);
  const outcome = market?.outcomes.find((o) => o.key === outcomeKey);
  return outcome ? outcome.label : outcomeKey.toUpperCase();
}

/** The single leading outcome, appended to a market list line when there is any action. */
function topOutcomeSuffix(market: Market): string {
  if (BigInt(market.totalStakedMotes) === 0n) return "";
  const odds = computeOdds(market);
  const top = odds.reduce((a, b) => (b.impliedProbability > a.impliedProbability ? b : a));
  const outcome = market.outcomes.find((o) => o.key === top.outcomeKey);
  const label = outcome ? outcome.label : top.outcomeKey;
  return ` — ${label} ${formatProbability(top.impliedProbability)}`;
}

/** CSPR to at most 2 decimals, trailing zeros trimmed: 12 → "12", 12.5 → "12.5", 12.34 → "12.34". */
function formatCspr(cspr: number): string {
  return Number(cspr.toFixed(2)).toString();
}
