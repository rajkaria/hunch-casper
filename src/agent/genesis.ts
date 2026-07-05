/**
 * Genesis — the market-maker agent. It watches CSPR.cloud-style signals and autonomously opens
 * new markets: it asks the LlmClient to frame the idea (advisory copy only — never the money
 * path), builds a config-driven `MarketDefinition` from a deterministic template, validates it
 * through the same generator every catalogue market passes, and registers it so it is instantly
 * live everywhere (explorer, MCP, betting, settlement). On-chain this is a MarketFactory
 * `register_market`; off-chain it is a `market-source` registration behind the same seam.
 *
 * `runGenesis` is a pure function of its trigger (which carries the deadline), so it is
 * deterministic and testable — the cron supplies the live signal + `now + window` deadline.
 */

import type { Container } from "@/lib/container";
import type { MarketDefinition } from "@/core/catalogue";
import { buildMarket } from "@/core/catalogue";
import type { Market, MarketOutcome, ResolverBinding } from "@/core/types";
import { buildDeployPlan } from "@/core/market-generator";
import { addCreatedMarket } from "@/adapters/mock/market-source";
import { appendAction } from "@/adapters/mock/activity-log";

/** A CSPR.cloud-style signal that motivates a new market. */
export interface GenesisTrigger {
  /** The metric read (e.g. "cspr_usd", "daily_deploys", "active_validators"). */
  metric: string;
  /** The observed value, as a string in the metric's native unit. */
  value: string;
  /** A short human unit label for the title (e.g. "$", "deploys"). */
  unitLabel: string;
  /** ISO deadline for the created market (the cron passes `now + window`). */
  deadlineIso: string;
  /** Monotone sequence for a deterministic unique slug (the cron passes the created-count). */
  seq: number;
  /**
   * Where the signal came from ("CSPR.cloud" | "Casper RPC" | …) — stamped into the market
   * subtitle so a live-RPC datum is never mislabelled as CSPR.cloud. Defaults to "CSPR.cloud".
   */
  sourceLabel?: string;
}

const YES_NO: MarketOutcome[] = [
  { key: "yes", label: "Yes" },
  { key: "no", label: "No" },
];

/** Scale a numeric string by `factor` to set a threshold either above or below the observed value. */
function thresholdFrom(value: string, factor: number): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return value;
  const bumped = n * factor;
  // Keep small prices readable, large integers whole.
  return bumped < 10 ? bumped.toFixed(4) : String(Math.round(bumped));
}

function slugify(metric: string): string {
  return metric.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Genesis rotates through several market SHAPES so its autonomous output isn't one templated bet.
 * Deterministic on `trigger.seq`, so it stays testable. `seq 0` is `gte` × 1.1 (the +10% "hold
 * above") — the anchor the tests pin — and later seqs add "break below" (`lte`) and wider bands, so
 * the created markets vary in direction and horizon, not just their metric.
 */
interface MarketShape {
  comparator: "gte" | "lte";
  factor: number;
  verb: string;
}
const SHAPES: readonly MarketShape[] = [
  { comparator: "gte", factor: 1.1, verb: "hold above" }, // seq 0 → +10% (pinned by tests)
  { comparator: "lte", factor: 0.9, verb: "fall below" }, // -10%
  { comparator: "gte", factor: 1.2, verb: "break above" }, // +20%
  { comparator: "lte", factor: 0.95, verb: "dip below" }, // -5%
];

/** Build a config-driven definition from a trigger + the LLM's framing copy (advisory subtitle). */
export function definitionFromTrigger(trigger: GenesisTrigger, framing: string): MarketDefinition {
  const shape = SHAPES[trigger.seq % SHAPES.length];
  const target = thresholdFrom(trigger.value, shape.factor);
  const resolver: ResolverBinding = {
    kind: "threshold",
    source: "cspr_cloud",
    metric: trigger.metric,
    target,
    comparator: shape.comparator,
    description:
      framing.trim() ||
      `Opened by Genesis from an observed ${trigger.metric} of ${trigger.value} — will it ${shape.verb} ${trigger.unitLabel}${target}?`,
  };
  return {
    slug: `genesis-${slugify(trigger.metric)}-${trigger.seq}`,
    title: `Will ${trigger.metric} ${shape.verb} ${trigger.unitLabel}${target}?`,
    subtitle: `Genesis · autonomously opened from ${trigger.sourceLabel ?? "CSPR.cloud"} (${trigger.metric} = ${trigger.unitLabel}${trigger.value})`,
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: 200,
    cadence: "one-shot",
    resolver,
    deadlineIso: trigger.deadlineIso,
    seedPoolMotes: { yes: "500000000000", no: "500000000000" },
  };
}

/** Run Genesis once against a trigger: frame → build → validate → register → return the market. */
export async function runGenesis(container: Container, trigger: GenesisTrigger): Promise<Market> {
  const framing = await container.llm.complete({
    system: "You are Genesis, a prediction-market maker on Casper. Propose one crisp, cleanly-resolvable market.",
    prompt: `Propose a market idea and one-line framing for the signal ${trigger.metric} = ${trigger.value}.`,
  });
  const def = definitionFromTrigger(trigger, framing);
  buildDeployPlan(def); // ABI-validate before registering (throws on a bad config)
  addCreatedMarket(def); // MarketFactory.register_market, off-chain mirror
  const market = buildMarket(def, container.network);
  appendAction({
    agent: "Genesis",
    kind: "market_created",
    marketId: market.id,
    marketTitle: market.title,
    narration: def.resolver.description,
    // No on-chain MarketFactory tx backs a runtime creation yet (the factory registration is a
    // deploy-time step), so a Genesis creation is always simulated until that lands.
    simulated: true,
  });
  return market;
}
