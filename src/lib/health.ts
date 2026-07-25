/**
 * Health input gathering — the impure half of the operator health surface. Reads config, env
 * presence (never env *values*), and probes KV; hands a plain snapshot to the pure evaluator in
 * `core/health.ts`.
 *
 * Secret discipline: this module answers "is X configured?" with a boolean and nothing else. No
 * key, token, URL, or account hash from a secret env var is ever placed in the returned object,
 * because the report is served over an unauthenticated endpoint. Contract package hashes are the
 * one exception — they are already public (`NEXT_PUBLIC_*`, and printed on the proof surface).
 */

import { chainMode } from "@/config/chain-mode";
import {
  csprClickAppIdsFromEnv,
  csprClickBundleUrl,
  resolveCsprClickAppId,
  walletPosture,
} from "@/config/csprclick";
import { DEFAULT_NETWORK, getNetworkConfig, type CasperNetwork } from "@/config/network";
import {
  buildHealthReport,
  type FleetBalance,
  type HealthInputs,
  type HealthReport,
  type LoopLivenessInput,
} from "@/core/health";
import { baseSlug } from "@/core/round-id";
import { hydrateEconomyState, probePersistence } from "@/adapters/persist/economy-state";
import { exportActivityState } from "@/adapters/mock/activity-log";
import { createContainer } from "@/lib/container";
import { PROPHETS } from "@/core/prophet-strategies";
import { prophetTurnCostMotes } from "@/agent/prophet";
import { breakerSnapshot } from "@/agent/bet-breaker";
import { quarantinedMarkets } from "@/agent/market-quarantine";

function isSet(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0;
}

/**
 * Newest recorded action + count, WITHOUT triggering the demo seed. `listActions()` seeds a cold
 * instance on read, which would make an empty economy report as a healthy one; the export path
 * has no such side effect.
 */
function economySnapshot(): { actionCount: number; newestActionTs: number | null } {
  const { actions } = exportActivityState();
  let newest: number | null = null;
  for (const a of actions) {
    if (typeof a.ts === "number" && (newest === null || a.ts > newest)) newest = a.ts;
  }
  return { actionCount: actions.length, newestActionTs: newest };
}

/**
 * The loop-liveness facts, read from the same seed-free export as `economySnapshot`.
 *
 * Markets are counted by BASE slug, so a recurring market's rounds do not inflate the distinct
 * count and hide a frozen rotation behind the very machinery meant to fix it.
 */
/**
 * How many events the chain fold can actually see, or `undefined` when it was not consulted.
 *
 * Bounded to one page per contract and failure-tolerant: this check exists to catch a blind fold,
 * and a health endpoint that hangs or 500s because the indexer is slow would be a worse failure
 * than the one it is reporting.
 */
async function chainEventCount(network: CasperNetwork): Promise<number | undefined> {
  if (chainMode() !== "real") return undefined;
  try {
    const events = await createContainer(network).events.fetch({ limit: 1 });
    return events.length;
  } catch {
    return undefined;
  }
}

function loopLiveness(nowMs: number): LoopLivenessInput {
  const { actions } = exportActivityState();
  const agents = new Set<string>();
  const markets = new Set<string>();
  let betCount = 0;
  let resolutionCount = 0;
  let oldestBetMs: number | null = null;

  for (const a of actions) {
    if (a.kind === "bet_placed") {
      betCount++;
      agents.add(a.agent);
      markets.add(baseSlug(a.marketId.split(":").pop() ?? a.marketId));
      if (typeof a.ts === "number" && (oldestBetMs === null || a.ts < oldestBetMs)) oldestBetMs = a.ts;
    } else if (a.kind === "market_resolved") {
      resolutionCount++;
    }
  }

  return {
    nowMs,
    betCount,
    resolutionCount,
    oldestBetMs,
    distinctAgents: agents.size,
    distinctMarkets: markets.size,
    recentActionCount: betCount,
  };
}

/**
 * The turn floor: what a Prophet's turn can cost it. Delegates to `prophetTurnCostMotes` — the
 * same number the cadence planner throttles on — so "funded" here and "may bet" there can never
 * disagree. They did, briefly: health billed a turn at the base stake while the planner billed
 * the doubled conviction bet, so a purse could read funded and still be throttled out.
 */
export const fleetTurnFloorMotes = prophetTurnCostMotes;

/**
 * Every agent's account and balance, read in parallel. A wallet that throws (unconfigured key,
 * RPC down) reports `"0"` rather than taking the health endpoint down with it — a health check
 * that fails when a subsystem fails is useless precisely when it is needed.
 */
async function fleetBalances(network: CasperNetwork): Promise<FleetBalance[]> {
  const { wallet } = createContainer(network);
  return Promise.all(
    PROPHETS.map(async (p): Promise<FleetBalance> => {
      try {
        const [account, balanceMotes] = await Promise.all([
          wallet.accountFor(p.id),
          wallet.balanceOf(p.id),
        ]);
        return {
          agentId: p.name,
          account: account.publicKeyHex,
          accountHash: account.accountHash,
          balanceMotes,
        };
      } catch {
        return { agentId: p.name, account: "unavailable", accountHash: "unavailable", balanceMotes: "0" };
      }
    }),
  );
}

export interface HealthOptions {
  /** Injected for tests: KV probe and clock. */
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function gatherHealth(
  network: CasperNetwork = DEFAULT_NETWORK,
  opts: HealthOptions = {},
): Promise<HealthReport> {
  const cfg = getNetworkConfig(network);
  // Restore the persisted economy BEFORE snapshotting it. A serverless instance starts with an
  // empty in-memory activity log, so reading it cold reported "no agent activity recorded" on a
  // healthy, actively-betting deployment — the health surface claiming the economy was dead while
  // KV held the bets and the feed rendered them. Health must answer for the deployment, not for
  // whichever instance happened to serve the probe.
  await hydrateEconomyState();
  const [persistence, fleet] = await Promise.all([probePersistence(opts.fetchImpl), fleetBalances(network)]);
  const inputs: HealthInputs = {
    network,
    chainMode: chainMode(),
    contracts: {
      marketFactory: cfg.contracts.marketFactory,
      oracleRegistry: cfg.contracts.oracleRegistry,
      vault: cfg.contracts.vault,
      vaultV2: cfg.contracts.vaultV2,
    },
    marketAddressCount: Object.keys(cfg.marketAddresses).length,
    persistence: {
      configured: persistence.configured,
      reachable: persistence.reachable,
      status: persistence.status,
      latencyMs: persistence.latencyMs,
      rev: persistence.rev,
    },
    x402: {
      payToConfigured: isSet("CASPER_X402_PAYTO"),
      legacyOptIn: process.env.CASPER_REAL_AGENT_X402 === "true",
    },
    signer: {
      bettorKeyConfigured: isSet("CASPER_BETTOR_KEY"),
      oracleKeyConfigured: isSet("CASPER_ORACLE_KEY"),
    },
    cronSecretConfigured: isSet("CRON_SECRET") || isSet("TICK_CRON_SECRET"),
    csprCloudKeyConfigured: isSet("CSPR_CLOUD_API_KEY"),
    wallet: {
      posture: walletPosture(
        resolveCsprClickAppId(network, csprClickAppIdsFromEnv()),
        csprClickBundleUrl(),
      ),
    },
    economy: economySnapshot(),
    loop: { ...loopLiveness(opts.now ?? Date.now()), chainEventCount: await chainEventCount(network) },
    fleet,
    breaker: (() => {
      const b = breakerSnapshot();
      return {
        consecutiveFailures: b.consecutiveFailures,
        trippedAt: b.trippedAt,
        lastFailureReason: b.lastFailure?.reason,
      };
    })(),
    quarantinedMarkets: quarantinedMarkets().map((m) => ({ slug: m.slug, reason: m.reason })),
    fleetMinBalanceMotes: fleetTurnFloorMotes(),
    now: opts.now ?? Date.now(),
  };
  return buildHealthReport(inputs);
}
