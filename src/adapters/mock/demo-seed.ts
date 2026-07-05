/**
 * Cold-start demo seed. On Vercel's ephemeral serverless the in-process ledgers reset on every cold
 * instance, and the economy tick only fires on a cron — so a judge landing on `/agents` between
 * ticks would see an empty feed and empty boards ("No agent activity yet"), the exact opposite of
 * the "self-running economy" pitch. This module deterministically seeds a coherent recent history —
 * a few resolved base markets (so the Agent PnL + oracle-accuracy boards populate) and a matching
 * activity feed — the FIRST time a dashboard/read route runs on a fresh instance.
 *
 * Safety: it NEVER runs under test (`NODE_ENV === "test"`, so the deterministic suites keep their
 * own clean state) and NEVER in real chain mode (`CASPER_CHAIN_MODE=real`, so mainnet/testnet with
 * real value never shows fabricated activity). Everything routes through the same pure payout engine
 * as a live bet, so the seeded board is internally consistent (agent PnL nets against house
 * liquidity exactly as a real settlement would).
 */

import type { CasperNetwork } from "@/config/network";
import { DEFAULT_NETWORK, explorerTransactionUrl } from "@/config/network";
import { chainMode } from "@/config/chain-mode";
import { csprToMotes } from "@/core/types";
import { findDefinition } from "@/core/catalogue";
import { ledgerRecordBet, ledgerSettle } from "./settlement-ledger";
import { oracleRecordResolution } from "./oracle-ledger";
import { isAccurateReading } from "./mock-oracle";
import { pseudoDeployHash } from "./mock-chain";
import { appendAction } from "./activity-log";

/** A resolved base market to seed: who staked on what, and the winning outcome. */
interface SeedMarket {
  slug: string;
  winner: string;
  /** [bettor id, outcome key, CSPR] — non-headline markets so the marquee ones stay live. */
  bets: readonly [string, string, number][];
}

const SEED: readonly SeedMarket[] = [
  {
    slug: "cspr-staking-apy-11",
    winner: "no",
    bets: [
      ["agent:momentum", "no", 3],
      ["agent:contrarian", "yes", 2],
      ["agent:value", "yes", 2],
      ["agent:chaos", "no", 1],
    ],
  },
  {
    slug: "casper-validators-100",
    winner: "yes",
    bets: [
      ["agent:momentum", "yes", 3],
      ["agent:contrarian", "no", 2],
      ["agent:value", "yes", 2],
      ["agent:chaos", "no", 1],
    ],
  },
  {
    slug: "cspr-total-staked-9b",
    winner: "no",
    bets: [
      ["agent:momentum", "no", 3],
      ["agent:contrarian", "yes", 2],
      ["agent:value", "no", 2],
      ["agent:chaos", "yes", 1],
    ],
  },
];

function shouldSeed(): boolean {
  return process.env.NODE_ENV !== "test" && chainMode() !== "real";
}

const settledNetworks = new Set<CasperNetwork>();
let activitySeeded = false;

function name(bettor: string): string {
  const bare = bettor.startsWith("agent:") ? bettor.slice("agent:".length) : bettor;
  return bare.replace(/^\w/, (c) => c.toUpperCase());
}

function label(slug: string, key: string): string {
  return findDefinition(slug)?.outcomes.find((o) => o.key === key)?.label ?? key;
}

/** Settle the seed markets for a network through the real payout engine (idempotent per network). */
function settleDemoMarkets(network: CasperNetwork): void {
  if (settledNetworks.has(network)) return;
  settledNetworks.add(network);
  for (const m of SEED) {
    const marketId = `${network}:${m.slug}`;
    try {
      for (const [bettor, outcomeKey, cspr] of m.bets) {
        ledgerRecordBet({ marketId, bettor, outcomeKey, amountMotes: csprToMotes(cspr) });
      }
      ledgerSettle(marketId, m.winner);
      oracleRecordResolution("arbiter", marketId, isAccurateReading(marketId));
    } catch {
      /* already settled by a live tick, or locked — keep the seed resilient and move on */
    }
  }
}

/** Seed the global activity feed once with a coherent recent history matching the settled board. */
function seedActivity(network: CasperNetwork): void {
  if (activitySeeded) return;
  activitySeeded = true;

  let t = Date.now() - 5 * 60_000; // history starts ~5 minutes ago
  const at = (): number => (t += 34_000); // ~34s between actions
  const link = (seed: string) => {
    const deployHash = pseudoDeployHash(seed);
    return { deployHash, explorerUrl: explorerTransactionUrl(network, deployHash), simulated: true };
  };

  for (const m of SEED) {
    const marketId = `${network}:${m.slug}`;
    const title = findDefinition(m.slug)?.title ?? m.slug;
    appendAction({
      agent: "Genesis",
      kind: "market_created",
      marketId,
      marketTitle: title,
      narration: `CSPR.cloud signalled a move — opening "${title}" for the swarm.`,
      ts: at(),
      ...link(`create:${marketId}`),
    });
    for (const [bettor, outcomeKey, cspr] of m.bets) {
      appendAction({
        agent: name(bettor),
        kind: "bet_placed",
        marketId,
        marketTitle: title,
        outcomeKey,
        amountMotes: csprToMotes(cspr),
        narration: `${name(bettor)} stakes ${cspr} CSPR on ${label(m.slug, outcomeKey)} via x402.`,
        ts: at(),
        ...link(`bet:${marketId}:${bettor}`),
      });
    }
    appendAction({
      agent: "Arbiter",
      kind: "market_resolved",
      marketId,
      marketTitle: title,
      outcomeKey: m.winner,
      narration: `I resolved "${title}" to ${label(m.slug, m.winner)} — reputation staked on the call.`,
      ts: at(),
      ...link(`resolve:${marketId}`),
    });
  }
}

/**
 * Ensure the demo economy is populated for `network` (default the site's default network). Safe to
 * call on every dashboard/read request — it self-guards (test/real mode) and is idempotent.
 */
export function ensureDemoSeed(network: CasperNetwork = DEFAULT_NETWORK): void {
  if (!shouldSeed()) return;
  settleDemoMarkets(network);
  seedActivity(network);
}

/**
 * Mark the demo seed as already applied — called when a persisted economy snapshot hydrates a
 * fresh instance (see `adapters/persist/economy-state.ts`). The hydrated state IS the real recent
 * history, so fabricating a second demo history on top would double-count the boards and duplicate
 * the feed; flipping the guards makes every later `ensureDemoSeed` a no-op on this instance.
 */
export function markDemoSeeded(): void {
  settledNetworks.add("testnet");
  settledNetworks.add("mainnet");
  activitySeeded = true;
}

/** Test-only: reset the seed guards so a suite can exercise the seeder in isolation. */
export function __resetDemoSeed(): void {
  settledNetworks.clear();
  activitySeeded = false;
}
