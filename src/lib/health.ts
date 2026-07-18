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
import { DEFAULT_NETWORK, getNetworkConfig, type CasperNetwork } from "@/config/network";
import { buildHealthReport, type FleetBalance, type HealthInputs, type HealthReport } from "@/core/health";
import { probePersistence } from "@/adapters/persist/economy-state";
import { exportActivityState } from "@/adapters/mock/activity-log";
import { createContainer } from "@/lib/container";
import { PROPHETS } from "@/core/prophet-strategies";
import { PROPHET_GAS_FLOOR_MOTES } from "@/agent/prophet";
import { csprToMotes } from "@/core/types";

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
 * The turn floor: the largest stake any Prophet places, plus the gas an agent's own transfer
 * costs. An agent below this sits out, so this is the number that decides whether a purse counts
 * as funded.
 */
export function fleetTurnFloorMotes(): string {
  const largestStake = PROPHETS.reduce((max, p) => Math.max(max, p.stakeCspr), 0);
  return (BigInt(csprToMotes(largestStake)) + PROPHET_GAS_FLOOR_MOTES).toString();
}

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
    economy: economySnapshot(),
    fleet,
    fleetMinBalanceMotes: fleetTurnFloorMotes(),
    now: opts.now ?? Date.now(),
  };
  return buildHealthReport(inputs);
}
