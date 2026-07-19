/**
 * Pure alert detection — turns a tick's raw actions into the handful that are worth pushing to a
 * channel. The fleet is always doing *something*; an alert stream that fired on every bet would be
 * noise nobody keeps subscribed. So this decides, deterministically, which actions clear the bar:
 *
 *   • a resolution — always alertable; a market settling is the payoff moment;
 *   • a pool move — a bet big enough to actually move the line, by absolute size OR by its share of
 *     the resulting pool (a 3 CSPR bet into an empty market moves the odds more than a 3 CSPR bet
 *     into a 1000 CSPR pool, and both matter to a watcher).
 *
 * It is pure and takes a `nowMs` and thresholds as arguments, so the same tick always yields the
 * same alerts and the tests assert exact output. The LLM narration is layered on *after* this, in
 * `lib/alerts.ts` — detection never depends on a model, because what counts as newsworthy is math,
 * not vibes.
 */

import type { AgentAction } from "@/adapters/mock/activity-log";
import type { Market } from "./types";
import { motesToCspr } from "./types";
import { computeOdds, formatProbability } from "./parimutuel-odds";

export type AlertKind = "pool_move" | "resolution";

export interface Alert {
  kind: AlertKind;
  /** `network:slug` id, matching the action's marketId. */
  marketId: string;
  slug: string;
  marketTitle: string;
  /** Deterministic base text — the alert stands on its own even if narration is unavailable. */
  headline: string;
  outcomeKey?: string;
  outcomeLabel?: string;
  /** The bet size for a pool move, in CSPR (already formatted). */
  amountCspr?: string;
  /** The acting agent's display name. */
  agent: string;
  /** Advisory LLM colour, added downstream; never present from pure detection. */
  narration?: string;
}

export interface AlertThresholds {
  /** A bet at or above this many CSPR is always a pool move, regardless of pool size. */
  bigBetCspr: number;
  /** A bet taking at least this share of the resulting pool is a pool move, regardless of size. */
  poolShare: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = { bigBetCspr: 5, poolShare: 0.2 };

function slugOf(marketId: string): string {
  const colon = marketId.indexOf(":");
  return colon >= 0 ? marketId.slice(colon + 1) : marketId;
}

function outcomeLabel(market: Market | undefined, key: string | undefined): string | undefined {
  if (!key) return undefined;
  const found = market?.outcomes.find((o) => o.key === key);
  return found ? found.label : key.toUpperCase();
}

/**
 * Detect the alertable events in one tick's actions. `marketsBySlug` is the post-tick read model,
 * used to compute the pool share of a bet and the resulting top-outcome odds for the headline.
 */
export function detectAlerts(
  actions: AgentAction[],
  marketsBySlug: Map<string, Market>,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): Alert[] {
  const alerts: Alert[] = [];
  for (const action of actions) {
    const slug = slugOf(action.marketId);
    const market = marketsBySlug.get(slug);
    const title = action.marketTitle ?? market?.title ?? slug;

    if (action.kind === "market_resolved") {
      const label = outcomeLabel(market, action.outcomeKey);
      alerts.push({
        kind: "resolution",
        marketId: action.marketId,
        slug,
        marketTitle: title,
        outcomeKey: action.outcomeKey,
        outcomeLabel: label,
        agent: action.agent,
        headline: label
          ? `Resolved: ${title} → ${label}`
          : `Resolved: ${title}`,
      });
      continue;
    }

    if (action.kind === "bet_placed" && action.amountMotes) {
      const amountCspr = motesToCspr(action.amountMotes);
      const poolMotes = market ? BigInt(market.totalStakedMotes) : 0n;
      const betMotes = BigInt(action.amountMotes);
      const share = poolMotes > 0n ? Number(betMotes) / Number(poolMotes) : 1;
      const isBig = amountCspr >= thresholds.bigBetCspr || share >= thresholds.poolShare;
      if (!isBig) continue;

      const label = outcomeLabel(market, action.outcomeKey);
      const oddsSuffix = market ? topOddsSuffix(market) : "";
      alerts.push({
        kind: "pool_move",
        marketId: action.marketId,
        slug,
        marketTitle: title,
        outcomeKey: action.outcomeKey,
        outcomeLabel: label,
        amountCspr: formatCspr(amountCspr),
        agent: action.agent,
        headline: `${action.agent} bet ${formatCspr(amountCspr)} CSPR on ${label ?? action.outcomeKey} — ${title}${oddsSuffix}`,
      });
    }
  }
  return alerts;
}

function topOddsSuffix(market: Market): string {
  if (BigInt(market.totalStakedMotes) === 0n) return "";
  const odds = computeOdds(market);
  const top = odds.reduce((a, b) => (b.impliedProbability > a.impliedProbability ? b : a));
  const label = market.outcomes.find((o) => o.key === top.outcomeKey)?.label ?? top.outcomeKey;
  return ` (${label} now ${formatProbability(top.impliedProbability)})`;
}

function formatCspr(cspr: number): string {
  return Number(cspr.toFixed(2)).toString();
}
