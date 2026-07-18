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
import { buildHealthReport, type HealthInputs, type HealthReport } from "@/core/health";
import { probePersistence } from "@/adapters/persist/economy-state";
import { exportActivityState } from "@/adapters/mock/activity-log";

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
  const persistence = await probePersistence(opts.fetchImpl);
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
    now: opts.now ?? Date.now(),
  };
  return buildHealthReport(inputs);
}
