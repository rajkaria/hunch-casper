/**
 * Alert narration + dispatch — the layer that turns detected alerts (pure math, `core/alerts.ts`)
 * into the messages a channel actually receives, with the fleet's LLM voice on top.
 *
 * The LLM is strictly advisory here, exactly as everywhere else in this codebase: it colours the
 * headline, it does not decide what fired or what any market pays. If narration fails or is slow,
 * the deterministic headline is sent unchanged — a model outage must never swallow an alert. Every
 * message ends with the embed/market link so a tap goes straight to a bet.
 *
 * Dispatch goes through a `BotTransport`, so in the demo it lands in the recorded outbox (nothing
 * posted externally — decision D2) and, when an operator sets `HUNCH_BOTS_LIVE=true` and a
 * broadcast chat, it goes to the channel. The tick route can call `broadcastTickAlerts` to make the
 * economy's own narration the alert stream; it is deliberately decoupled so a narration failure
 * can never break the money-moving tick.
 */

import type { Container } from "@/lib/container";
import type { BotTransport } from "@/ports/bot-transport";
import type { Alert } from "@/core/alerts";
import { detectAlerts, type AlertThresholds } from "@/core/alerts";
import type { AgentAction } from "@/adapters/mock/activity-log";
import { marketUrl } from "@/config/site";
import type { Market } from "@/core/types";

/** Narrate one alert with the fleet's voice, falling back to the headline on any LLM trouble. */
export async function narrateAlert(container: Container, alert: Alert): Promise<string> {
  const ask =
    alert.kind === "resolution"
      ? `Write a one-sentence, punchy resolution summary for a prediction-market alert. Market: "${alert.marketTitle}". Winning outcome: ${alert.outcomeLabel ?? "n/a"}. No emojis, under 30 words.`
      : `Write a one-sentence, punchy alert that ${alert.agent} just placed a ${alert.amountCspr} CSPR bet on "${alert.outcomeLabel ?? alert.outcomeKey}" in "${alert.marketTitle}". Convey momentum. No emojis, under 30 words.`;
  try {
    const text = (await container.llm.complete({ prompt: ask, temperature: 0.7 })).trim();
    return text.length > 0 ? text : alert.headline;
  } catch {
    return alert.headline;
  }
}

/** Format a narrated alert into the message body sent to a channel. */
export function formatAlertMessage(alert: Alert, narration: string): string {
  const icon = alert.kind === "resolution" ? "🏁" : "📈";
  const link = marketUrl(alert.slug);
  return `${icon} ${narration}\n${link}`;
}

/**
 * Narrate + send a batch of alerts to one channel. Returns the messages sent (for tests + the
 * runbook's dry-run inspection). Sends sequentially so channel order matches tick order.
 */
export async function broadcastAlerts(
  container: Container,
  transport: BotTransport,
  replyTo: string,
  alerts: Alert[],
): Promise<string[]> {
  const sent: string[] = [];
  for (const alert of alerts) {
    const narration = await narrateAlert(container, alert);
    const text = formatAlertMessage(alert, narration);
    await transport.send({ replyTo, text });
    sent.push(text);
  }
  return sent;
}

/**
 * End-to-end convenience: detect the alertable events in a tick's actions, then narrate + dispatch
 * them. The caller supplies the post-tick markets (for pool-share math) and the channel. Kept out
 * of the economy tick itself so an alerting fault is isolated from settlement.
 */
export async function broadcastTickAlerts(
  container: Container,
  transport: BotTransport,
  replyTo: string,
  actions: AgentAction[],
  markets: Market[],
  thresholds?: AlertThresholds,
): Promise<{ alerts: Alert[]; messages: string[] }> {
  const bySlug = new Map(markets.map((m) => [m.slug, m]));
  const alerts = detectAlerts(actions, bySlug, thresholds);
  const messages = await broadcastAlerts(container, transport, replyTo, alerts);
  return { alerts, messages };
}
