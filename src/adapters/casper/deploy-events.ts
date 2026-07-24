/**
 * `EventsPort` over CSPR.cloud **deploys**, multiplexed across every contract the app routes bets
 * to.
 *
 * Two defects made the chain-derived boards return `eventCount: 0` in production, and both are
 * fixed here:
 *
 * 1. **There is no contract-events endpoint.** `stream-events.ts` reads
 *    `/contracts/<hash>/events`; probed live against testnet, that path — and `/contract-events`,
 *    and `/events` — all answer `endpoint not found`. The CES stream it was written against does
 *    not exist on this API, so the fold could never have seen anything. What CSPR.cloud *does*
 *    serve is `/deploys?contract_package_hash=…`, with each call's inner argument blob already
 *    byte-parsed — enough to reconstruct every bet, creation and resolution.
 * 2. **The scope was one contract.** The container wired the stream to `contracts.vaultV2` alone
 *    while bets route to five per-market v1 packages FIRST (`deploy-plan.ts` prefers the per-market
 *    map). Every v1 bet was structurally invisible. This adapter folds all of them.
 *
 * A failed call is never folded. `error_message` non-null means the transaction reverted — the
 * money did not move — and indexing it would put stakes on the boards that no vault is holding.
 * That is the same invariant `real-chain.ts` enforces on the write side.
 */

import type { CasperNetwork } from "@/config/network";
import { getNetworkConfig } from "@/config/network";
import type { ChainEvent, ChainEventKind, EventQuery, EventsPort } from "@/ports/events";
import { decodeNamedArgs, argString, argNumber, argStringList } from "@/core/casper-args";

const FETCH_TIMEOUT_MS = 12_000;
/** CSPR.cloud's page cap. */
const PAGE_SIZE = 100;
/** Hard ceiling per contract per fold, so one pathological package cannot pin the lambda. */
const MAX_PAGES = 10;

/**
 * The vault's entry points, mapped to fold kinds. Anything else a package exposes — `admin`,
 * `approve_oracle`, `open_creation`, `set_vault` — is deliberately unmapped: the indexer folds
 * money and outcomes, and quietly accepting an unknown call as a known one is how a board ends up
 * confidently wrong.
 */
const ENTRY_POINT_KINDS: Record<string, ChainEventKind> = {
  create_market: "market_created",
  bet: "bet_placed",
  resolve: "market_resolved",
  claim: "payout_claimed",
};

/** One CSPR.cloud deploy row, as far as this adapter reads it. */
interface DeployRow {
  args?: Record<string, { parsed?: unknown }>;
  block_height?: number;
  deploy_hash?: string;
  timestamp?: string;
  caller_public_key?: string;
  error_message?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Strip an optional `hash-` prefix — the env map stores package hashes either way. */
export function bareHash(hash: string): string {
  return hash.startsWith("hash-") ? hash.slice(5) : hash;
}

/**
 * PURE decode of one deploy row into a fold event. Returns `null` for anything unusable — a
 * reverted call, an unmapped entry point, a row missing its ordering key — so a single odd row
 * can never corrupt a fold.
 */
export function decodeDeployEvent(raw: unknown): ChainEvent | null {
  const row = asRecord(raw) as DeployRow | null;
  if (!row) return null;

  // A reverted transaction moved no money. Folding it would show stakes the vault is not holding.
  if (row.error_message !== null && row.error_message !== undefined) return null;

  const args = row.args ?? {};
  const entryPoint = args.entry_point?.parsed;
  if (typeof entryPoint !== "string") return null;
  const kind = ENTRY_POINT_KINDS[entryPoint];
  if (!kind) return null;

  const blockHeight = typeof row.block_height === "number" ? row.block_height : undefined;
  const deployHash = typeof row.deploy_hash === "string" ? row.deploy_hash : undefined;
  if (blockHeight === undefined || !deployHash) return null;

  const inner = args.args?.parsed;
  const decoded = Array.isArray(inner) ? decodeNamedArgs(inner as number[]) : [];
  const marketId = argString(decoded, "market_id");
  if (!marketId) return null;

  const timestampMs = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  const amountMotes = (() => {
    const parsed = args.attached_value?.parsed ?? args.amount?.parsed;
    if (typeof parsed === "string" && /^\d+$/.test(parsed)) return parsed;
    if (typeof parsed === "number" && Number.isSafeInteger(parsed)) return String(parsed);
    return undefined;
  })();

  const event: ChainEvent = {
    kind,
    marketId,
    blockHeight,
    // A deploy is one call, so there is no intra-block event index to carry. Ordering falls back
    // to (blockHeight, deployHash), which is stable and total.
    eventIndex: 0,
    deployHash,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
  };

  if (kind === "bet_placed") {
    event.bettor = row.caller_public_key;
    event.outcomeKey = argString(decoded, "outcome");
    event.amountMotes = amountMotes;
  } else if (kind === "market_created") {
    const feeBps = argNumber(decoded, "fee_bps");
    if (feeBps !== undefined) event.feeBps = Number(feeBps);
    event.outcomeKeys = argStringList(decoded, "outcomes");
  } else if (kind === "market_resolved") {
    event.outcomeKey = argString(decoded, "winning_outcome") ?? argString(decoded, "outcome");
    event.voided = event.outcomeKey === undefined;
    event.oracleId = row.caller_public_key;
  } else if (kind === "payout_claimed") {
    event.claimant = row.caller_public_key;
    event.amountMotes = amountMotes;
  }
  return event;
}

/** Decode a page of deploys, dropping anything unusable. */
export function decodeDeployEvents(raw: unknown): ChainEvent[] {
  const list = Array.isArray(raw) ? raw : asRecord(raw)?.data;
  if (!Array.isArray(list)) return [];
  return list.map(decodeDeployEvent).filter((e): e is ChainEvent => e !== null);
}

/** Total order for the fold: block height, then deploy hash so ties are deterministic. */
export function sortEvents(events: ChainEvent[]): ChainEvent[] {
  return [...events].sort(
    (a, b) => a.blockHeight - b.blockHeight || a.deployHash.localeCompare(b.deployHash),
  );
}

export interface DeployEventsOptions {
  /** Every contract package the app routes calls to — the v1 per-market map plus the v2 vault. */
  contractHashes: string[];
  apiKey?: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
}

/**
 * Build the multiplexed events port.
 *
 * Contracts are read concurrently and merged into one ordered stream. A contract whose read fails
 * contributes nothing rather than failing the fold: a partial board is honest and diagnosable via
 * `provenance`, while an exception would blank the boards entirely on any single transient error.
 */
export function createDeployEvents(network: CasperNetwork, opts: DeployEventsOptions): EventsPort {
  const cfg = getNetworkConfig(network);
  const base = cfg.csprCloudBaseUrl;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const hashes = Array.from(new Set(opts.contractHashes.filter(Boolean).map(bareHash)));

  async function fetchPage(hash: string, page: number): Promise<ChainEvent[]> {
    const url = `${base}/deploys?contract_package_hash=${hash}&page_size=${PAGE_SIZE}&page=${page}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(url, {
        signal: controller.signal,
        headers: opts.apiKey ? { Authorization: opts.apiKey } : undefined,
      });
      if (!res.ok) return [];
      return decodeDeployEvents(await res.json());
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchContract(hash: string, limit: number): Promise<ChainEvent[]> {
    const out: ChainEvent[] = [];
    for (let page = 1; page <= maxPages && out.length < limit; page++) {
      const batch = await fetchPage(hash, page);
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break; // last page
    }
    return out;
  }

  return {
    network,
    async fetch(query: EventQuery = {}): Promise<ChainEvent[]> {
      const limit = query.limit ?? 5_000;
      const perContract = Math.max(1, Math.ceil(limit / Math.max(1, hashes.length)));
      const batches = await Promise.all(hashes.map((h) => fetchContract(h, perContract)));
      let merged = sortEvents(batches.flat());
      if (query.fromBlockHeight !== undefined) {
        merged = merged.filter((e) => e.blockHeight >= query.fromBlockHeight!);
      }
      return merged.slice(0, limit);
    },
    subscribe() {
      // Deploys are a polled REST resource; there is no push channel to subscribe to. Returning a
      // no-op unsubscribe is honest — the boards refresh on read.
      return () => {};
    },
  };
}
