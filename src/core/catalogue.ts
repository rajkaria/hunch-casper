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
 * (no wall-clock drift) and the demo reproducible. For a RECURRING market (`cadence !== "one-shot"`)
 * the literal is only the FIRST round's boundary: every later round is derived from the cadence by
 * `effectiveDeadlineMs`, against an injected clock. Reading `deadlineIso` directly for a recurring
 * market is the bug that kept "CSPR up or down this hour?" open for eight days — it never matured,
 * so the Arbiter never resolved it, so the boards, the league and every meta-market stayed empty.
 */

import type { CasperNetwork } from "@/config/network";
import { BUILDATHON_FINALISTS, BUILDATHON_MARKET_SLUG } from "@/core/buildathon-field";
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
  /**
   * Settled history — a market that has already matured and been resolved. It stays in the
   * catalogue so the board keeps its record (and so the ledger keeps its copy), but it is not a
   * live market and the freshness guard in `catalogue.test.ts` does not hold it to a future
   * deadline. Live definitions leave this unset.
   */
  retired?: boolean;
  /**
   * The network a runtime-created market was born on. Catalogue definitions leave this unset —
   * they exist on every network by design. Created/round/user definitions are one-network facts:
   * without this, a testnet-born round was mirrored onto the mainnet board as a "locked" market
   * with a fabricated seed pool.
   */
  network?: "testnet" | "mainnet";
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

/**
 * The first cohort's deadline. Every market bound to it matured on 2026-08-01 and was settled by
 * the Arbiter, so it stays exactly where it is: these definitions are the board's settled history,
 * and their on-chain twins in `HunchVault` carry the same instant. Moving it would not reopen
 * anything — `create_market` writes a market's deadline once and the vault has no entry point to
 * change it, so the chain would go on rejecting every bet the app offered.
 */
const AUG_1 = "2026-08-01T00:00:00.000Z";

/**
 * The successor cohort's deadline — three months out, comfortably past the buildathon finals and
 * any judging slippage, so nothing on the live board expires mid-review.
 *
 * Successors rather than edits, for the reason above: a matured market is settled history, and the
 * only honest way to keep asking its question is to ask it again, as a new market, with a target
 * that is a real question at today's readings rather than one the world left behind. Every target
 * below is anchored to a value measured on 2026-08-01 and the measurement is stated beside it.
 */
const NOV_1 = "2026-11-01T00:00:00.000Z";

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
    retired: true,
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
    retired: true,
    seedPoolMotes: { yes: "640000000000", no: "1360000000000" },
  },
  {
    // Slug kept for routing stability (it is the on-chain market id and the env address map key),
    // but the cadence is DAILY: at 3.74 CSPR a create plus 6.317 a resolve, an hourly round costs
    // ~276 CSPR/day and gives the treasury five days. Daily holds the operator's 8-week floor.
    // The title says what the market actually does — a market whose name outruns its cadence is
    // precisely the defect this catalogue just had.
    slug: "cspr-hourly-updown",
    title: "CSPR up or down today?",
    subtitle: "Casper-native · recurring daily round",
    category: "casper-native",
    outcomes: UP_DOWN,
    feeBps: FEE_BPS,
    cadence: "daily",
    resolver: {
      kind: "direction",
      source: "coingecko",
      metric: "cspr_usd",
      description: "CSPR close versus the day's open — flat rounds void and refund.",
    },
    // A recurring parent's literal is its FIRST round's boundary, and `effectiveDeadlineMs`
    // ignores it entirely once rounds are rolling (`currentRound` derives them from the cadence
    // against the clock). What the literal still decides is the PARENT row's own status — and a
    // parent in the past reads as "locked", i.e. a template that looks like a dead market and
    // refuses the bets the tests and the bot place against it. Kept in the future for that reason.
    deadlineIso: "2026-11-01T01:00:00.000Z",
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
    retired: true,
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
    retired: true,
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
    retired: true,
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
    retired: true,
    seedPoolMotes: { yes: "700000000000", no: "500000000000" },
  },

  // ── Provably-fair recurring ────────────────────────────────────────────────────────────
  {
    // Slug kept for routing stability. A 5-minute round is 288 creates + 288 resolves a day —
    // ~3,310 CSPR, more than twice the whole treasury, so it could never have run at its
    // advertised cadence. Daily is what is affordable; drand still decides it.
    slug: "coin-flip-5m",
    title: "The Flip — Heads, Tails, or Tie?",
    subtitle: "Provably fair · daily drand round",
    category: "provably-fair",
    outcomes: [
      { key: "heads", label: "Heads" },
      { key: "tails", label: "Tails" },
      { key: "tie", label: "Tie" },
    ],
    feeBps: FEE_BPS,
    cadence: "daily",
    resolver: {
      kind: "coin_flip",
      source: "drand",
      metric: "drand_parity",
      description: "Parity of the committed drand beacon round — Tie on the rare exact split.",
    },
    // First-round boundary; kept in the future so the parent row is a live template, not a
    // locked one (see `cspr-hourly-updown` above).
    deadlineIso: "2026-11-01T00:05:00.000Z",
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
    retired: true,
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
    retired: true,
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
    retired: true,
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
    retired: true,
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
    retired: true,
    seedPoolMotes: { yes: "1000000000000", no: "1000000000000" },
  },

  // ── Casper-native public-good markets (S27) ─────────────────────────────────────────────
  // Feeds the ecosystem cares about: does the upgrade ship, is the validator set healthy, are
  // grant milestones hit. Real recipes, category-policy-clean, useful as public probability feeds.
  {
    slug: "casper-condor-upgrade-ships-aug",
    title: "Casper 2.0 (Condor) mainnet upgrade activates by Aug 1?",
    subtitle: "Casper-native · protocol milestone",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "condor_activation_height",
      target: "1",
      comparator: "gte",
      description: "The Condor protocol upgrade has activated on mainnet (activation height recorded) by the deadline.",
    },
    deadlineIso: AUG_1,
    retired: true,
    seedPoolMotes: { yes: "900000000000", no: "500000000000" },
  },
  {
    slug: "casper-validator-health-90",
    title: "Casper validator-set health above 90% by Aug 1?",
    subtitle: "Casper-native · network health",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "validator_uptime_pct",
      target: "90",
      comparator: "gte",
      description: "Mean active-validator uptime at or above 90% over the window ending at the snapshot.",
    },
    deadlineIso: AUG_1,
    retired: true,
    seedPoolMotes: { yes: "820000000000", no: "380000000000" },
  },
  {
    slug: "casper-grant-milestones-aug",
    title: "At least 10 ecosystem grant milestones completed by Aug 1?",
    subtitle: "Casper-native · public-goods funding",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "grant_milestones_completed",
      target: "10",
      comparator: "gte",
      description: "Count of ecosystem grant milestones marked complete at or above 10 at the snapshot.",
    },
    deadlineIso: AUG_1,
    retired: true,
    seedPoolMotes: { yes: "600000000000", no: "600000000000" },
  },

  // ── The live cohort (successors to the settled Aug 1 markets) ──────────────────────────
  //
  // Same metrics, same feeds, same resolvers — new questions. Each target is set against a
  // reading taken on 2026-08-01 so the market is a genuine question rather than a foregone
  // conclusion: the retired cohort asked whether CSPR would clear $0.05 when it trades at
  // $0.0019, and a market nobody can be wrong about teaches the board nothing.
  //
  // No seed pools. Every one of these opens at zero on both sides, so the first real bet sets the
  // line and nothing on the board is house money wearing a bettor's clothes.
  {
    slug: "cspr-price-0025-nov",
    title: "CSPR above $0.0025 by Nov 1?",
    subtitle: "Casper-native · CoinGecko close",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "coingecko",
      metric: "cspr_usd",
      target: "0.0025",
      comparator: "gte",
      description: "CSPR spot price at or above $0.0025 at the Nov 1 snapshot (spot was $0.00192 when this market opened).",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "cspr-mcap-40m-nov",
    title: "CSPR market cap above $40M by Nov 1?",
    subtitle: "Casper-native · CoinGecko market cap",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "coingecko",
      metric: "cspr_mcap_usd",
      target: "40000000",
      comparator: "gte",
      description: "CSPR circulating market cap at or above $40,000,000 at the snapshot (it was $32.0M when this market opened).",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "casper-daily-tx-4k-nov",
    title: "Casper daily transaction count above 4,000 by Nov 1?",
    subtitle: "Casper-native · CSPR.cloud",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "daily_deploys",
      target: "4000",
      comparator: "gte",
      description: "On-chain transaction count for the settlement day at or above 4,000 (mainnet ran ~3,226/day, measured across 30 blocks at 8.03s each, when this market opened).",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "casper-validators-75-nov",
    title: "Casper active validators above 75 by Nov 1?",
    subtitle: "Casper-native · CSPR.cloud",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "active_validators",
      target: "75",
      comparator: "gte",
      description: "Active validator slots at or above 75 at the snapshot era (70 of the auction's slots were filled when this market opened).",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "cspr-staking-apy-8-nov",
    title: "Casper staking APY above 8% by Nov 1?",
    subtitle: "Casper-native · CSPR.cloud",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "staking_apy_pct",
      target: "8",
      comparator: "gte",
      description: "Network staking APY at or above 8% at the snapshot — a live question at 11.34B CSPR bonded, where the reward rate sits close to the threshold either way.",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "cspr-total-staked-115b-nov",
    title: "Total CSPR staked above 11.5B by Nov 1?",
    subtitle: "Casper-native · CSPR.cloud",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "total_staked_cspr",
      target: "11500000000",
      comparator: "gte",
      description: "Total CSPR bonded across validators at or above 11,500,000,000 (11.339B was bonded, summed across the era's validator weights, when this market opened).",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "casper-block-94m-nov",
    title: "Casper mainnet past block 9,400,000 by Nov 1?",
    subtitle: "Casper-native · chain height",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "latest_block_height",
      target: "9400000",
      comparator: "gte",
      description: "Mainnet block height at or above 9,400,000 at the snapshot. A knife-edge by construction: height 8,454,000 at 8.03s/block projects to ~9,439,912 by Nov 1, so block-time variance decides it.",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "casper-validator-health-95-nov",
    title: "Casper validator-set health above 95% by Nov 1?",
    subtitle: "Casper-native · validator uptime",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "validator_uptime_pct",
      target: "95",
      comparator: "gte",
      description: "Share of the active validator set meeting the uptime bar, at or above 95% at the snapshot.",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "casper-grant-milestones-15-nov",
    title: "At least 15 ecosystem grant milestones completed by Nov 1?",
    subtitle: "Casper-native · public-goods funding",
    category: "casper-native",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "cspr_cloud",
      metric: "grant_milestones_completed",
      target: "15",
      comparator: "gte",
      description: "Count of ecosystem grant milestones marked complete at or above 15 at the snapshot.",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "tbill-yield-35-nov",
    title: "3-month T-bill yield above 3.5% by Nov 1?",
    subtitle: "RWA · macro feed",
    category: "rwa",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "macro_feed",
      metric: "tbill_3m_yield_pct",
      target: "3.5",
      comparator: "gte",
      description: "US 3-month Treasury bill yield at or above 3.5% at the snapshot (it printed 3.69% on the last session before this market opened).",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "gold-4200-nov",
    title: "Gold above $4,200/oz by Nov 1?",
    subtitle: "RWA · macro feed",
    category: "rwa",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "macro_feed",
      metric: "gold_usd_oz",
      target: "4200",
      comparator: "gte",
      description: "Spot gold at or above $4,200 per troy ounce at the snapshot (spot was $4,043.70 when this market opened).",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "stablecoin-supply-320b-nov",
    title: "Total stablecoin supply above $320B by Nov 1?",
    subtitle: "RWA · macro feed",
    category: "rwa",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "macro_feed",
      metric: "stablecoin_supply_usd",
      target: "320000000000",
      comparator: "gte",
      description: "Aggregate stablecoin circulating supply at or above $320,000,000,000 at the snapshot ($306.8B across 413 assets when this market opened).",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "btc-70k-nov",
    title: "BTC above $70k by Nov 1?",
    subtitle: "RWA · CoinGecko close",
    category: "rwa",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "coingecko",
      metric: "btc_usd",
      target: "70000",
      comparator: "gte",
      description: "BTC spot at or above $70,000 at the snapshot (spot was $63,016 when this market opened).",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
  },
  {
    slug: "eth-2k-nov",
    title: "ETH above $2,000 by Nov 1?",
    subtitle: "RWA · CoinGecko close",
    category: "rwa",
    outcomes: YES_NO,
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "threshold",
      source: "coingecko",
      metric: "eth_usd",
      target: "2000",
      comparator: "gte",
      description: "ETH spot at or above $2,000 at the snapshot (spot was $1,868 when this market opened).",
    },
    deadlineIso: NOV_1,
    seedPoolMotes: { yes: "0", no: "0" },
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
    // A recurring parent's literal is its FIRST round's boundary — `effectiveDeadlineMs` derives
    // every real round from the cadence — but it still decides the PARENT row's own status, and a
    // parent in the past reads as a locked market that refuses the bets placed against it. Carried
    // to a true weekly boundary past Nov 1 for the same reason the two daily parents were
    // (f619fd7), and on the grid so the first round is not shorter than every round after it.
    deadlineIso: "2026-11-05T00:00:00.000Z",
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
    // A recurring parent's literal is its FIRST round's boundary — `effectiveDeadlineMs` derives
    // every real round from the cadence — but it still decides the PARENT row's own status, and a
    // parent in the past reads as a locked market that refuses the bets placed against it. Carried
    // to a true weekly boundary past Nov 1 for the same reason the two daily parents were
    // (f619fd7), and on the grid so the first round is not shorter than every round after it.
    deadlineIso: "2026-11-05T00:00:00.000Z",
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
    // A recurring parent's literal is its FIRST round's boundary — `effectiveDeadlineMs` derives
    // every real round from the cadence — but it still decides the PARENT row's own status, and a
    // parent in the past reads as a locked market that refuses the bets placed against it. Carried
    // to a true weekly boundary past Nov 1 for the same reason the two daily parents were
    // (f619fd7), and on the grid so the first round is not shorter than every round after it.
    deadlineIso: "2026-11-05T00:00:00.000Z",
    seedPoolMotes: { yes: "1180000000000", no: "220000000000" },
  },

  // ── Community · the buildathon field ───────────────────────────────────────────────────
  {
    slug: BUILDATHON_MARKET_SLUG,
    title: "Which project wins the Casper Agentic Buildathon 2026?",
    subtitle: "Community · 177 finalists · no house liquidity",
    category: "community",
    // 177 candidates, keyed by DoraHacks BUIDL id. Far past what `HunchVault` can hold
    // (`MAX_OUTCOMES = 8`), which is why this one market routes to its own `FieldMarket`
    // contract — see `contracts/src/field_market.rs`.
    outcomes: BUILDATHON_FINALISTS.map((f) => ({ key: f.id, label: f.name })),
    feeBps: FEE_BPS,
    cadence: "one-shot",
    resolver: {
      kind: "nway_winner",
      source: "attested",
      metric: "buildathon_grand_prize",
      description:
        "The BUIDL named grand-prize winner in the organizers' published Casper Agentic Buildathon 2026 results, attested by the Arbiter with the announcement URL + content hash committed on chain.",
    },
    // The backstop, not the trigger: the oracle may resolve the moment results are announced,
    // which closes betting immediately. See `FieldMarket::resolve`.
    deadlineIso: "2026-08-31T23:59:59.000Z",
    // No house liquidity. Every one of the 177 pools starts at zero, so the first real bet sets
    // the line and nothing on the board is the operator's own money wearing a bettor's clothes.
    seedPoolMotes: Object.fromEntries(BUILDATHON_FINALISTS.map((f) => [f.id, "0"])),
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
