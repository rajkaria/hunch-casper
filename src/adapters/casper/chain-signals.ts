/**
 * Live chain signals — the real data feed behind Genesis. Where the demo rotation fabricates a
 * plausible signal, this adapter reads a GENUINE chain datum, trying sources in a safe order:
 *
 *   1. CSPR.cloud `/auction-metrics` (needs `CSPR_CLOUD_API_KEY`) → live active-validator count;
 *   2. the network's public node RPC `chain_get_block` (keyless) → latest block height;
 *   3. null — the caller falls back to the deterministic demo rotation, so a flaky upstream can
 *      never take the Genesis route down.
 *
 * Fetch-based with hard timeouts, no chain SDK, and pure/defensive parsers (malformed JSON →
 * null, never a throw): the network edge is thin and the decision logic is offline-testable.
 * Server-only — called from the Genesis route, never the client bundle.
 */

import type { CasperNetwork } from "@/config/network";
import { getNetworkConfig } from "@/config/network";

export interface LiveSignal {
  /** Metric key (feeds `GenesisTrigger.metric` and the resolver binding). */
  metric: string;
  /** Observed value as a string in the metric's native unit. */
  value: string;
  /** Human unit label for market titles ("" for counts). */
  unitLabel: string;
  /** Where the datum came from — surfaces in the market subtitle for honest provenance. */
  sourceLabel: string;
}

const TIMEOUT_MS = 4_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** CSPR.cloud `/validators` response → an active-validator-count signal, or null. */
export function parseValidatorSignal(json: unknown): LiveSignal | null {
  // `/auction-metrics` answers with a single object: { data: { active_validator_number, … } }.
  // (The older `/validators?page=…` read of `item_count` never worked — that endpoint requires
  // an `era_id` and 400s without one, so every keyed request silently fell back to node RPC.)
  const data = asRecord(asRecord(json)?.data);
  const count = data?.active_validator_number;
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  return { metric: "active_validators", value: String(count), unitLabel: "", sourceLabel: "CSPR.cloud" };
}

/** Node-RPC `chain_get_block` response (Casper 2.0 or legacy shape) → a block-height signal, or null. */
export function parseBlockHeightSignal(json: unknown): LiveSignal | null {
  const result = asRecord(asRecord(json)?.result);
  if (!result) return null;
  // Casper 2.0 (Condor): result.block_with_signatures.block.Version2.header.height
  const versioned = asRecord(asRecord(asRecord(result.block_with_signatures)?.block));
  const v2Header = asRecord(asRecord(versioned?.Version2)?.header);
  const v1Header = asRecord(asRecord(versioned?.Version1)?.header);
  // Legacy: result.block.header.height
  const legacyHeader = asRecord(asRecord(result.block)?.header);
  const height = (v2Header ?? v1Header ?? legacyHeader)?.height;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return null;
  return { metric: "latest_block_height", value: String(height), unitLabel: "", sourceLabel: "Casper RPC" };
}

async function withTimeout(run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchLiveSignalOptions {
  /** CSPR.cloud API key; defaults to `CSPR_CLOUD_API_KEY`. Without one, CSPR.cloud is skipped. */
  apiKey?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** Read one live chain signal for a network, or null when every source is unavailable. */
export async function fetchLiveSignal(
  network: CasperNetwork,
  opts: FetchLiveSignalOptions = {},
): Promise<LiveSignal | null> {
  const cfg = getNetworkConfig(network);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env.CSPR_CLOUD_API_KEY;

  if (apiKey) {
    try {
      const res = await withTimeout((signal) =>
        fetchImpl(`${cfg.csprCloudBaseUrl}/auction-metrics`, {
          headers: { authorization: apiKey },
          signal,
        }),
      );
      if (res.ok) {
        const parsed = parseValidatorSignal(await res.json());
        if (parsed) return parsed;
      }
    } catch {
      /* fall through to the next source */
    }
  }

  try {
    const res = await withTimeout((signal) =>
      fetchImpl(cfg.nodeRpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain_get_block", params: [] }),
        signal,
      }),
    );
    if (res.ok) {
      const parsed = parseBlockHeightSignal(await res.json());
      if (parsed) return parsed;
    }
  } catch {
    /* fall through */
  }

  return null;
}
