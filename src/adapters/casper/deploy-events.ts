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
 *
 * A third defect kept the *closing* half of the loop invisible, and is fixed here too:
 *
 * 3. **Settlement rows carry no entry-point name.** `bet` and `create_market` are payable, so they
 *    go through Odra's proxy session, whose envelope puts the target's name in
 *    `args.entry_point` — the only place this adapter looked. `resolve`, `claim` and `void` attach
 *    no motes, so they are sent as direct stored-contract calls, and CSPR.cloud describes those
 *    rows *entirely differently*: no `entry_point` argument at all, just a numeric
 *    `entry_point_id`, with the call's real named arguments (`market_id`, `winning_outcome`) at the
 *    top of `args` instead of a byte blob. Every resolution and payout therefore decoded to `null`,
 *    and the landing page reported "Rounds settled: 0" while the chain held five resolutions.
 *
 * The id is resolved through `/contracts/<contract_hash>/entry-points`, which is a *paged* table
 * defaulting to ten rows — the vault publishes 32, so `resolve` (25th alphabetically) is off the
 * default page. Requesting that default and concluding "unknown id" would reproduce the same
 * blindness through a working code path, which is why `ENTRY_POINTS_PAGE_SIZE` is explicit and
 * paginated, and why a test pins the request against the real ten-row default response.
 *
 * Shapes here are transcribed from live testnet rows (vault v2 `ce451360…`, captured 2026-07-25),
 * not inferred: see `test/fixtures/cspr-cloud-stored-deploys.json` and
 * `test/fixtures/cspr-cloud-entry-points.json`.
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
 * Entry-point table page size. MUST be explicit: the endpoint defaults to ten rows and the vault
 * publishes 32, so the default page stops at `deadline_of` and omits `resolve` outright.
 */
const ENTRY_POINTS_PAGE_SIZE = 100;
/** No real contract has 500+ entry points; this only stops a malformed `page_count` from looping. */
const ENTRY_POINTS_MAX_PAGES = 5;

/**
 * The vault's entry points, mapped to fold kinds. Anything else a package exposes — `admin`,
 * `approve_oracle`, `open_creation`, `set_vault` — is deliberately unmapped: the indexer folds
 * money and outcomes, and quietly accepting an unknown call as a known one is how a board ends up
 * confidently wrong.
 *
 * `void` and `refund` are mapped because they are the same two state transitions under different
 * names: `HunchVault::void` closes a round with no winner (the fold's `voided` flag), and
 * `HunchVault::refund` is a thin alias that calls `claim` and emits the same `PayoutClaimed`. An
 * oracle voiding a round from the CLI must not leave the board showing it as still open.
 */
const ENTRY_POINT_KINDS: Record<string, ChainEventKind> = {
  create_market: "market_created",
  bet: "bet_placed",
  resolve: "market_resolved",
  void: "market_resolved",
  claim: "payout_claimed",
  refund: "payout_claimed",
};

/** One CSPR.cloud deploy row, as far as this adapter reads it. */
interface DeployRow {
  args?: Record<string, { parsed?: unknown }>;
  block_height?: number;
  deploy_hash?: string;
  timestamp?: string;
  caller_public_key?: string;
  error_message?: string | null;
  /** Present on stored-contract calls, where it is the ONLY record of which entry point ran. */
  entry_point_id?: number;
  /** Which contract version served the call — the key the entry-point table is indexed by. */
  contract_hash?: string;
}

/** `entry_point_id` → name, as served by `/contracts/<contract_hash>/entry-points`. */
export type EntryPointNames = ReadonlyMap<number, string>;

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
 * Which entry point a row ran, across BOTH row shapes CSPR.cloud serves.
 *
 * The proxied (payable) shape names it in `args.entry_point`. The stored shape does not name it at
 * all — `entry_point_id` is a foreign key into the contract's entry-point table, so without that
 * table the row is genuinely undecidable and the honest answer is `undefined`, not a guess.
 */
function readEntryPoint(row: DeployRow, names?: EntryPointNames): string | undefined {
  const fromEnvelope = row.args?.entry_point?.parsed;
  if (typeof fromEnvelope === "string") return fromEnvelope;
  return typeof row.entry_point_id === "number" ? names?.get(row.entry_point_id) : undefined;
}

/** Read a top-level named argument off a stored call, where args are CLValues rather than bytes. */
function namedArgString(row: DeployRow, name: string): string | undefined {
  const parsed = row.args?.[name]?.parsed;
  return typeof parsed === "string" ? parsed : undefined;
}

/**
 * PURE decode of one deploy row into a fold event. Returns `null` for anything unusable — a
 * reverted call, an unmapped entry point, a row missing its ordering key — so a single odd row
 * can never corrupt a fold.
 *
 * `entryPointNames` is required to decode stored calls (`resolve`, `claim`, `void`); without it
 * they are dropped rather than misread.
 */
export function decodeDeployEvent(raw: unknown, entryPointNames?: EntryPointNames): ChainEvent | null {
  const row = asRecord(raw) as DeployRow | null;
  if (!row) return null;

  // A reverted transaction moved no money. Folding it would show stakes the vault is not holding.
  if (row.error_message !== null && row.error_message !== undefined) return null;

  const args = row.args ?? {};
  const entryPoint = readEntryPoint(row, entryPointNames);
  if (!entryPoint) return null;
  const kind = ENTRY_POINT_KINDS[entryPoint];
  if (!kind) return null;

  const blockHeight = typeof row.block_height === "number" ? row.block_height : undefined;
  const deployHash = typeof row.deploy_hash === "string" ? row.deploy_hash : undefined;
  if (blockHeight === undefined || !deployHash) return null;

  // Proxied calls carry the inner call as a byte blob; stored calls carry real named CLValues.
  const inner = args.args?.parsed;
  const decoded = Array.isArray(inner) ? decodeNamedArgs(inner as number[]) : [];
  const marketId = argString(decoded, "market_id") ?? namedArgString(row, "market_id");
  if (!marketId) return null;

  const timestampMs = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  const amountMotes = (() => {
    // Only the proxy envelope carries a stake. A stored row's sibling `payment_amount` is the gas
    // budget, not money that moved, and reading it would invent payouts out of transaction fees.
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
    event.outcomeKey =
      argString(decoded, "winning_outcome") ??
      argString(decoded, "outcome") ??
      namedArgString(row, "winning_outcome");
    // `void` takes only a market id, so the absence of a winner IS the signal — the round closed
    // with nobody right and every stake refundable.
    event.voided = event.outcomeKey === undefined;
    event.oracleId = row.caller_public_key;
  } else if (kind === "payout_claimed") {
    event.claimant = row.caller_public_key;
    // Left undefined for a stored `claim`: the payout is computed inside the contract and appears
    // in its `PayoutClaimed` event, not in the deploy's arguments. `stats.ts` reports the claim
    // count rather than inventing a CSPR figure the deploy history cannot support.
    event.amountMotes = amountMotes;
  }
  return event;
}

/** Decode a page of deploys, dropping anything unusable. */
export function decodeDeployEvents(raw: unknown, entryPointNames?: EntryPointNames): ChainEvent[] {
  const list = Array.isArray(raw) ? raw : asRecord(raw)?.data;
  if (!Array.isArray(list)) return [];
  return list
    .map((row) => decodeDeployEvent(row, entryPointNames))
    .filter((e): e is ChainEvent => e !== null);
}

/**
 * PURE parse of one `/entry-points` page into the id → name map the stored-call decode needs.
 */
export function decodeEntryPoints(raw: unknown): Map<number, string> {
  const list = Array.isArray(raw) ? raw : asRecord(raw)?.data;
  const names = new Map<number, string>();
  if (!Array.isArray(list)) return names;
  for (const item of list) {
    const rec = asRecord(item);
    if (typeof rec?.id === "number" && typeof rec.name === "string") names.set(rec.id, rec.name);
  }
  return names;
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

  /**
   * Entry-point tables, keyed by contract hash and memoised for the port's lifetime — the table is
   * immutable once a contract version is on chain, and re-reading it on every fold would triple
   * the request count for no new information.
   */
  const entryPointCache = new Map<string, Promise<EntryPointNames>>();

  /** GET → parsed JSON, or `null`. A read that fails degrades the fold; it never throws through it. */
  async function getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(url, {
        signal: controller.signal,
        headers: opts.apiKey ? { Authorization: opts.apiKey } : undefined,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchRawPage(hash: string, page: number): Promise<unknown[]> {
    const url = `${base}/deploys?contract_package_hash=${hash}&page_size=${PAGE_SIZE}&page=${page}`;
    const body = await getJson(url);
    const list = Array.isArray(body) ? body : asRecord(body)?.data;
    return Array.isArray(list) ? list : [];
  }

  async function fetchRawContract(hash: string, limit: number): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= maxPages && out.length < limit; page++) {
      const batch = await fetchRawPage(hash, page);
      out.push(...batch);
      if (batch.length < PAGE_SIZE) break; // last page
    }
    return out;
  }

  async function loadEntryPointNames(contractHash: string): Promise<EntryPointNames> {
    const cached = entryPointCache.get(contractHash);
    if (cached) return cached;
    const pending = (async () => {
      const names = new Map<number, string>();
      for (let page = 1; page <= ENTRY_POINTS_MAX_PAGES; page++) {
        const url = `${base}/contracts/${contractHash}/entry-points?page_size=${ENTRY_POINTS_PAGE_SIZE}&page=${page}`;
        const body = await getJson(url);
        const list = Array.isArray(body) ? body : asRecord(body)?.data;
        if (!Array.isArray(list) || list.length === 0) break;
        for (const [id, name] of decodeEntryPoints(list)) names.set(id, name);
        if (list.length < ENTRY_POINTS_PAGE_SIZE) break;
      }
      return names as EntryPointNames;
    })();
    entryPointCache.set(contractHash, pending);
    // An empty map means the read failed or the contract is unknown. Caching that would blind the
    // fold to every future settlement on this contract, so a failure is retried on the next fold.
    void pending.then((names) => {
      if (names.size === 0) entryPointCache.delete(contractHash);
    });
    return pending;
  }

  /**
   * Decode raw rows, first fetching the entry-point table for every contract version that has a
   * row identifying its entry point only by id. Contracts whose rows are all proxied cost no extra
   * request.
   */
  async function decodeRows(rows: unknown[]): Promise<ChainEvent[]> {
    const needsTable = new Set<string>();
    for (const raw of rows) {
      const row = asRecord(raw) as DeployRow | null;
      if (!row || typeof row.contract_hash !== "string") continue;
      if (readEntryPoint(row) === undefined && typeof row.entry_point_id === "number") {
        needsTable.add(row.contract_hash);
      }
    }
    const tables = new Map<string, EntryPointNames>(
      await Promise.all(
        [...needsTable].map(
          async (h) => [h, await loadEntryPointNames(h)] as [string, EntryPointNames],
        ),
      ),
    );
    const out: ChainEvent[] = [];
    for (const raw of rows) {
      const contractHash = (asRecord(raw) as DeployRow | null)?.contract_hash;
      const event = decodeDeployEvent(
        raw,
        typeof contractHash === "string" ? tables.get(contractHash) : undefined,
      );
      if (event) out.push(event);
    }
    return out;
  }

  return {
    network,
    async fetch(query: EventQuery = {}): Promise<ChainEvent[]> {
      const limit = query.limit ?? 5_000;
      const perContract = Math.max(1, Math.ceil(limit / Math.max(1, hashes.length)));
      const batches = await Promise.all(hashes.map((h) => fetchRawContract(h, perContract)));
      let merged = sortEvents(await decodeRows(batches.flat()));
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
