/**
 * The market catalogue — config-driven, one definition per market (the "one-const" pattern).
 * A definition is network-agnostic; `buildCatalogue(network)` materialises live `Market`
 * objects for a given Casper network. S3 expands this to the full 15+; S0 seeds a
 * representative slice across all four categories so the explorer is alive.
 *
 * Deadlines and pools are fixed literals on purpose — deterministic data keeps tests stable
 * (no wall-clock drift) and the demo reproducible.
 */

import type { CasperNetwork } from "@/config/network";
import type { Market, MarketCategory, MarketOutcome } from "@/core/types";

export interface MarketDefinition {
  slug: string;
  title: string;
  subtitle?: string;
  category: MarketCategory;
  outcomes: MarketOutcome[];
  deadlineIso: string;
  /** Seed pool per outcome key, in motes — deterministic starting liquidity for demos. */
  seedPoolMotes: Record<string, string>;
}

const YES_NO: MarketOutcome[] = [
  { key: "yes", label: "Yes" },
  { key: "no", label: "No" },
];

const UP_DOWN: MarketOutcome[] = [
  { key: "up", label: "Up" },
  { key: "down", label: "Down" },
];

export const MARKET_DEFINITIONS: readonly MarketDefinition[] = [
  {
    slug: "cspr-price-05-aug",
    title: "CSPR above $0.05 by Aug 1?",
    subtitle: "Casper-native · CoinGecko close",
    category: "casper-native",
    outcomes: YES_NO,
    deadlineIso: "2026-08-01T00:00:00.000Z",
    seedPoolMotes: { yes: "1200000000000", no: "800000000000" },
  },
  {
    slug: "cspr-hourly-updown",
    title: "CSPR up or down this hour?",
    subtitle: "Casper-native · recurring hourly round",
    category: "casper-native",
    outcomes: UP_DOWN,
    deadlineIso: "2026-08-01T01:00:00.000Z",
    seedPoolMotes: { up: "540000000000", down: "460000000000" },
  },
  {
    slug: "casper-daily-deploys-30k",
    title: "Casper daily deploy count above 30,000?",
    subtitle: "Casper-native · CSPR.cloud",
    category: "casper-native",
    outcomes: YES_NO,
    deadlineIso: "2026-08-01T00:00:00.000Z",
    seedPoolMotes: { yes: "300000000000", no: "700000000000" },
  },
  {
    slug: "coin-flip-5m",
    title: "The Flip — Heads, Tails, or Tie?",
    subtitle: "Provably fair · 5-minute drand round",
    category: "provably-fair",
    outcomes: [
      { key: "heads", label: "Heads" },
      { key: "tails", label: "Tails" },
      { key: "tie", label: "Tie" },
    ],
    deadlineIso: "2026-08-01T00:05:00.000Z",
    seedPoolMotes: { heads: "480000000000", tails: "480000000000", tie: "40000000000" },
  },
  {
    slug: "tbill-yield-45",
    title: "3-month T-bill yield above 4.5% by Aug 1?",
    subtitle: "RWA · macro rate",
    category: "rwa",
    outcomes: YES_NO,
    deadlineIso: "2026-08-01T00:00:00.000Z",
    seedPoolMotes: { yes: "900000000000", no: "1100000000000" },
  },
  {
    slug: "btc-150k-aug",
    title: "BTC above $150k by Aug 1?",
    subtitle: "RWA · oracle price feed",
    category: "rwa",
    outcomes: YES_NO,
    deadlineIso: "2026-08-01T00:00:00.000Z",
    seedPoolMotes: { yes: "700000000000", no: "2300000000000" },
  },
  {
    slug: "prophet-race-weekly",
    title: "Which Prophet tops the board this week?",
    subtitle: "Meta · agents betting on agents",
    category: "meta",
    outcomes: [
      { key: "momentum", label: "Momentum" },
      { key: "contrarian", label: "Contrarian" },
      { key: "value", label: "Value" },
      { key: "chaos", label: "Chaos" },
    ],
    deadlineIso: "2026-08-03T00:00:00.000Z",
    seedPoolMotes: {
      momentum: "620000000000",
      contrarian: "410000000000",
      value: "330000000000",
      chaos: "140000000000",
    },
  },
];

function sumMotes(pool: Record<string, string>): string {
  let total = 0n;
  for (const v of Object.values(pool)) total += BigInt(v);
  return total.toString();
}

export function buildMarket(def: MarketDefinition, network: CasperNetwork): Market {
  return {
    id: `${network}:${def.slug}`,
    slug: def.slug,
    title: def.title,
    subtitle: def.subtitle,
    category: def.category,
    outcomes: def.outcomes,
    network,
    status: "open",
    deadlineIso: def.deadlineIso,
    totalStakedMotes: sumMotes(def.seedPoolMotes),
    poolByOutcomeMotes: { ...def.seedPoolMotes },
  };
}

export function buildCatalogue(network: CasperNetwork): Market[] {
  return MARKET_DEFINITIONS.map((def) => buildMarket(def, network));
}
