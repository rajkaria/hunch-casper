/**
 * The market catalogue — config-driven, one definition per market (the "one-const" pattern).
 *
 * A definition is network-agnostic. From a single `MarketDefinition` the S3 engine derives
 * three things (see `market-generator.ts`):
 *   1. the **off-chain cache row** — `buildMarket(def, network)` → a live `Market`;
 *   2. the **on-chain deploy plan** — `buildDeployPlan(def, …)` → the `ParimutuelMarket.init`
 *      + `MarketFactory.register_market` args;
 *   3. the **resolver binding** — carried verbatim on the definition, read by the S6 Arbiter.
 * Adding a market is one const, and that scalability is itself a judge-facing story.
 *
 * Deadlines and pools are fixed literals on purpose — deterministic data keeps tests stable
 * (no wall-clock drift) and the demo reproducible.
 */

import type { CasperNetwork } from "@/config/network";
import type {
  Market,
  MarketCadence,
  MarketCategory,
  MarketOutcome,
  ResolverBinding,
} from "@/core/types";

export interface MarketDefinition {
  slug: string;
  title: string;
  subtitle?: string;
  category: MarketCategory;
  outcomes: MarketOutcome[];
  /** Parimutuel fee in basis points, taken only from the losing pool (< 10_000). */
  feeBps: number;
  /** How often the market opens a fresh round (declarative; the scheduler is a later sprint). */
  cadence: MarketCadence;
  /** Declarative resolution rule — how the Arbiter decides the winning outcome. */
  resolver: ResolverBinding;
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

/** Default parimutuel fee (2%), mirroring the live Hunch product and the vault's primary test. */
const FEE_BPS = 200;

const AUG_1 = "2026-08-01T00:00:00.000Z";

export const MARKET_DEFINITIONS: readonly MarketDefinition[] = [
  // ── Casper-native (read via CSPR.cloud / CoinGecko) ────────────────────────────────────
  {
    slug: "cspr-price-05-aug",
    title: "CSPR above $0.05 by Aug 1?",
    subtitle: "Casper-native · CoinGecko close",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "coingecko",
      metric: "cspr_usd",
      target: "0.05",
      comparator: "gte",
      description: "CSPR spot price at or above $0.05 at the Aug 1 snapshot.",
    },
    deadlineIso: AUG_1,
    seedPoolMotes: { yes: "1200000000000", no: "800000000000" },
  },
  {
    slug: "cspr-mcap-1b-aug",
    title: "CSPR market cap above $1B by Aug 1?",
    subtitle: "Casper-native · CoinGecko market cap",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "coingecko",
      metric: "cspr_mcap_usd",
      target: "1000000000",
      comparator: "gte",
      description: "CSPR circulating market cap at or above $1,000,000,000 at the snapshot.",
    },
    deadlineIso: AUG_1,
    seedPoolMotes: { yes: "640000000000", no: "1360000000000" },
  },
  {
    slug: "cspr-hourly-updown",
    title: "CSPR up or down this hour?",
    subtitle: "Casper-native · recurring hourly round",
    category: "casper-native",
    outcomes: UP_DOWN,
    feeBps: FEE_BPS,
    cadence: "hourly",
    resolver: {
      kind: "direction",
      source: "coingecko",
      metric: "cspr_usd",
      description: "CSPR close versus the hour's open — flat rounds void and refund.",
    },
    deadlineIso: "2026-08-01T01:00:00.000Z",
    seedPoolMotes: { up: "540000000000", down: "460000000000" },
  },
  {
    slug: "casper-daily-deploys-30k",
    title: "Casper daily deploy count above 30,000?",
    subtitle: "Casper-native · CSPR.cloud",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "daily_deploys",
      target: "30000",
      comparator: "gte",
      description: "On-chain deploy count for the settlement day at or above 30,000.",
    },
    deadlineIso: AUG_1,
    seedPoolMotes: { yes: "300000000000", no: "700000000000" },
  },
  {
    slug: "casper-validators-100",
    title: "Casper active validators above 100?",
    subtitle: "Casper-native · CSPR.cloud",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "active_validators",
      target: "100",
      comparator: "gte",
      description: "Active validator slots at or above 100 at the snapshot era.",
    },
    deadlineIso: AUG_1,
    seedPoolMotes: { yes: "820000000000", no: "480000000000" },
  },
  {
    slug: "cspr-staking-apy-11",
    title: "Casper staking APY above 11%?",
    subtitle: "Casper-native · CSPR.cloud",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "staking_apy_pct",
      target: "11",
      comparator: "gte",
      description: "Network staking APY at or above 11% at the snapshot.",
    },
    deadlineIso: AUG_1,
    seedPoolMotes: { yes: "410000000000", no: "590000000000" },
  },
  {
    slug: "cspr-total-staked-9b",
    title: "Total CSPR staked above 9B by Aug 1?",
    subtitle: "Casper-native · CSPR.cloud",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "total_staked_cspr",
      target: "9000000000",
      comparator: "gte",
      description: "Total CSPR bonded across validators at or above 9,000,000,000 CSPR.",
    },
    deadlineIso: AUG_1,
    seedPoolMotes: { yes: "700000000000", no: "500000000000" },
  },

  // ── Provably-fair recurring ────────────────────────────────────────────────────────────
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
    feeBps: FEE_BPS,
    cadence: "5-minute",
    resolver: {
      kind: "coin_flip",
      source: "drand",
      metric: "drand_parity",
      description: "Parity of the committed drand beacon round — Tie on the rare exact split.",
    },
    deadlineIso: "2026-08-01T00:05:00.000Z",
    seedPoolMotes: { heads: "480000000000", tails: "480000000000", tie: "40000000000" },
  },

  // ── RWA / macro ────────────────────────────────────────────────────────────────────────
  {
    slug: "tbill-yield-45",
    title: "3-month T-bill yield above 4.5% by Aug 1?",
    subtitle: "RWA · macro rate",
    category: "rwa",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "macro_feed",
      metric: "tbill_3m_yield_pct",
      target: "4.5",
      comparator: "gte",
      description: "US 3-month Treasury bill yield at or above 4.5% at the snapshot.",
    },
    deadlineIso: AUG_1,
    seedPoolMotes: { yes: "900000000000", no: "1100000000000" },
  },
  {
    slug: "gold-3500-aug",
    title: "Gold above $3,500/oz by Aug 1?",
    subtitle: "RWA · spot commodity",
    category: "rwa",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "macro_feed",
      metric: "gold_usd_oz",
      target: "3500",
      comparator: "gte",
      description: "Spot gold at or above $3,500 per troy ounce at the snapshot.",
    },
    deadlineIso: AUG_1,
    seedPoolMotes: { yes: "560000000000", no: "840000000000" },
  },
  {
    slug: "btc-150k-aug",
    title: "BTC above $150k by Aug 1?",
    subtitle: "RWA · oracle price feed",
    category: "rwa",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "coingecko",
      metric: "btc_usd",
      target: "150000",
      comparator: "gte",
      description: "Bitcoin spot at or above $150,000 at the snapshot.",
    },
    deadlineIso: AUG_1,
    seedPoolMotes: { yes: "700000000000", no: "2300000000000" },
  },
  {
    slug: "eth-6k-aug",
    title: "ETH above $6k by Aug 1?",
    subtitle: "RWA · oracle price feed",
    category: "rwa",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "coingecko",
      metric: "eth_usd",
      target: "6000",
      comparator: "gte",
      description: "Ether spot at or above $6,000 at the snapshot.",
    },
    deadlineIso: AUG_1,
    seedPoolMotes: { yes: "820000000000", no: "1180000000000" },
  },
  {
    slug: "stablecoin-supply-300b",
    title: "Total stablecoin supply above $300B by Aug 1?",
    subtitle: "RWA · aggregate supply",
    category: "rwa",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "macro_feed",
      metric: "stablecoin_supply_usd",
      target: "300000000000",
      comparator: "gte",
      description: "Aggregate stablecoin circulating supply at or above $300,000,000,000.",
    },
    deadlineIso: AUG_1,
    seedPoolMotes: { yes: "1000000000000", no: "1000000000000" },
  },

  // ── Meta / agent-performance (the novelty) ─────────────────────────────────────────────
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
    feeBps: FEE_BPS,
    cadence: "weekly",
    resolver: {
      kind: "nway_winner",
      source: "internal",
      metric: "prophet_pnl",
      description: "The Prophet with the highest realized PnL over the weekly window.",
    },
    deadlineIso: "2026-08-03T00:00:00.000Z",
    seedPoolMotes: {
      momentum: "620000000000",
      contrarian: "410000000000",
      value: "330000000000",
      chaos: "140000000000",
    },
  },
  {
    slug: "momentum-vs-contrarian-weekly",
    title: "Momentum or Contrarian — who out-earns this week?",
    subtitle: "Meta · head-to-head Prophet duel",
    category: "meta",
    outcomes: [
      { key: "momentum", label: "Momentum" },
      { key: "contrarian", label: "Contrarian" },
    ],
    feeBps: FEE_BPS,
    cadence: "weekly",
    resolver: {
      kind: "nway_winner",
      source: "internal",
      metric: "prophet_pnl",
      description: "Whichever of Momentum or Contrarian posts the higher realized weekly PnL.",
    },
    deadlineIso: "2026-08-03T00:00:00.000Z",
    seedPoolMotes: { momentum: "560000000000", contrarian: "440000000000" },
  },
  {
    slug: "arbiter-accuracy-95",
    title: "Arbiter weekly resolution accuracy above 95%?",
    subtitle: "Meta · the oracle's reputation, on the line",
    category: "meta",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "weekly",
    resolver: {
      kind: "threshold",
      source: "internal",
      metric: "arbiter_accuracy_pct",
      target: "95",
      comparator: "gte",
      description: "Arbiter's on-chain resolution accuracy over the week at or above 95%.",
    },
    deadlineIso: "2026-08-03T00:00:00.000Z",
    seedPoolMotes: { yes: "1180000000000", no: "220000000000" },
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
    feeBps: def.feeBps,
    deadlineIso: def.deadlineIso,
    totalStakedMotes: sumMotes(def.seedPoolMotes),
    poolByOutcomeMotes: { ...def.seedPoolMotes },
  };
}

export function buildCatalogue(network: CasperNetwork): Market[] {
  return MARKET_DEFINITIONS.map((def) => buildMarket(def, network));
}

/** Look up a single definition by slug (network-agnostic). */
export function findDefinition(slug: string): MarketDefinition | undefined {
  return MARKET_DEFINITIONS.find((d) => d.slug === slug);
}
