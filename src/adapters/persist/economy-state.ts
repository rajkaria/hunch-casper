/**
 * Env-gated KV persistence for the in-process economy state — the fix for "a judge's bet vanishes
 * when the next request lands on another lambda". The four mock ledgers (settlement, activity,
 * oracle reputation, Genesis-created markets) are module singletons that reset on every serverless
 * cold start and silently diverge across instances. This module folds ALL of them into one
 * versioned JSON envelope under a single key and:
 *
 *   • **hydrates** it once per instance (`hydrateEconomyState`) before the first read — awaited by
 *     every `MarketStorePort` method and by the read routes BEFORE the demo-seed decision, so a
 *     hydrated instance shows the real persisted history, never a fabricated seed on top of it;
 *   • **persists** it after every mutation (`persistEconomyState`) — the state modules announce
 *     mutations through the cycle-free `economy-persist-hook` (this module imports them to
 *     serialize, so they must never import it back), and this module registers the hook at load.
 *
 * KV protocol: Upstash Redis REST (Vercel KV compatible). Reads use `GET <url>/get/<key>` →
 * `{ result: string | null }`. Writes use the canonical POST-command form — `POST <url>` with body
 * `["SET", "<key>", "<value>"]` — because the value is a full JSON snapshot that would blow past
 * URL-length limits in the `GET /set/<key>/<value>` form.
 *
 * Guarantees & limits (documented, deliberate):
 *   • Unconfigured (default: local, CI, tests) → every function is a fast synchronous no-op.
 *   • KV downtime never breaks the app: 3s timeout, errors are warned once and swallowed.
 *   • Same-tick persists coalesce into one in-flight write; a mutation during a write re-queues
 *     one more write.
 *   • Across instances every write is MERGE-ON-PERSIST, not last-writer-wins: the writer GETs the
 *     stored envelope, merges it into memory (activity by ts+agent+market+kind identity, created
 *     markets by slug, settlement by market id with settled-beats-unsettled, oracle by resolution
 *     id, breaker/quarantine by newest timestamp), and writes the union. Last-writer-wins truncated
 *     the production history on 2026-07-20 (round counter 42 → 5) when a warm instance flushed a
 *     stale view over everyone else's writes; a merge makes concurrent writers commutative instead.
 *   • The write itself is optimistic-concurrency guarded: each envelope carries a monotonic `rev`,
 *     and the SET runs as a Lua compare-and-set (write only if the stored rev is still the one we
 *     merged against), retried a bounded number of times. Every guard FAILS OPEN to a plain SET —
 *     a KV without EVAL, a read outage, or exhausted retries degrade to the old behaviour, never
 *     to a lost flush. Demo-grade durability, not the money path (the chain stays the source of
 *     truth for money).
 */

import {
  exportSettlementState,
  importSettlementState,
  type LedgerEntry,
  type SettlementSnapshot,
} from "@/adapters/mock/settlement-ledger";
import {
  ACTIVITY_CAP,
  exportActivityState,
  importActivityState,
  type ActivitySnapshot,
  type AgentAction,
} from "@/adapters/mock/activity-log";
import {
  exportOracleState,
  importOracleState,
  type OracleSnapshot,
} from "@/adapters/mock/oracle-ledger";
import type { OracleReputationState } from "@/core/oracle-reputation";
import {
  exportCreatedMarkets,
  importCreatedMarkets,
  type CreatedMarketsSnapshot,
} from "@/adapters/mock/market-source";
import type { MarketDefinition } from "@/core/catalogue";
import {
  exportBreakerState,
  importBreakerState,
  type BreakerSnapshot,
} from "@/agent/bet-breaker";
import {
  exportQuarantine,
  exportReleasedMarkets,
  importQuarantine,
  importReleasedMarkets,
  type QuarantinedMarket,
} from "@/agent/market-quarantine";
import { markDemoSeeded } from "@/adapters/mock/demo-seed";
import { setEconomyPersistHook } from "@/adapters/persist/economy-persist-hook";

/** The single KV key the whole economy snapshot lives under. Versioned so a future envelope shape
 * can move to `:v2` without ever mis-parsing old data. */
export const ECONOMY_KV_KEY = "hunch:economy:v1";

const TIMEOUT_MS = 3_000;

/** The versioned envelope folding all four module snapshots into one JSON document. */
interface EconomyEnvelope {
  v: 1;
  /** ISO timestamp of the snapshot — diagnostic only. */
  savedAt: string;
  /** Monotonic revision for optimistic concurrency: the writer compare-and-sets against the rev it
   * merged with. Optional: absent in envelopes written before merge-on-persist (treated as 0). */
  rev?: number;
  settlement: SettlementSnapshot;
  activity: ActivitySnapshot;
  oracle: OracleSnapshot;
  created: CreatedMarketsSnapshot;
  /** Optional: absent in envelopes written before the bet breaker existed. */
  breaker?: BreakerSnapshot;
  /** Optional: absent in envelopes written before market quarantine existed. */
  quarantine?: QuarantinedMarket[];
  /** Release tombstones (`[slug, releasedAt]`) so a merge can tell "released" from "never
   * quarantined". Optional: absent in envelopes written before merge-on-persist. */
  quarantineReleased?: [string, number][];
}

// ── Config ──────────────────────────────────────────────────────────────────────────────────────

interface KvConfig {
  url: string;
  token: string;
}

/** Read the KV endpoint from env: Vercel-KV/marketplace names first, then plain Upstash names.
 * Read per call (not cached) so tests can stub env freely. */
function kvConfig(): KvConfig | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/** Whether a KV endpoint is configured — unset means every function here is a no-op. */
export function persistenceConfigured(): boolean {
  return kvConfig() !== null;
}

// ── Serialize / apply (pure-ish over the four module snapshots) ─────────────────────────────────

/** The current in-memory economy as one versioned envelope object. */
function currentEnvelope(): EconomyEnvelope {
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    settlement: exportSettlementState(),
    activity: exportActivityState(),
    oracle: exportOracleState(),
    created: exportCreatedMarkets(),
    breaker: exportBreakerState(),
    quarantine: exportQuarantine(),
    quarantineReleased: exportReleasedMarkets(),
  };
}

/** Snapshot the whole economy into one versioned JSON envelope. */
export function serializeEconomyState(): string {
  return JSON.stringify(currentEnvelope());
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** `[string, object][]` — the JSON shape both Map-backed snapshots serialize their entries to. */
function isPairArray(x: unknown): x is [string, Record<string, unknown>][] {
  return (
    Array.isArray(x) &&
    x.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && isRecord(e[1]))
  );
}

/**
 * Defensive envelope validation. KV is written only by this module, but the payload still crosses
 * a network + a human-editable dashboard, so a bad document must degrade to "ignore and keep the
 * in-memory state", never a crash. Checks the version and every per-module container shape; the
 * leaf objects are trusted (same writer, versioned key).
 */
function isEnvelope(x: unknown): x is EconomyEnvelope {
  if (!isRecord(x) || x.v !== 1) return false;
  if (!isRecord(x.settlement) || !isPairArray(x.settlement.entries)) return false;
  if (
    !isRecord(x.activity) ||
    typeof x.activity.counter !== "number" ||
    !Array.isArray(x.activity.actions) ||
    !x.activity.actions.every((a: unknown) => isRecord(a) && typeof a.seq === "number")
  ) {
    return false;
  }
  if (
    !isRecord(x.oracle) ||
    !isPairArray(x.oracle.reputations) ||
    !Array.isArray(x.oracle.recorded) ||
    !x.oracle.recorded.every((k: unknown) => typeof k === "string")
  ) {
    return false;
  }
  if (
    !isRecord(x.created) ||
    !Array.isArray(x.created.created) ||
    !x.created.created.every((d: unknown) => isRecord(d) && typeof d.slug === "string")
  ) {
    return false;
  }
  return true;
}

/**
 * Apply a serialized envelope, REPLACING the four modules' state. Returns `false` (state
 * untouched) on any malformed payload — never throws. On success it also marks the demo seed as
 * done: hydrated state is the real history, so `ensureDemoSeed` must not fabricate a second one
 * on top of it.
 */
export function applyEconomyState(json: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  if (!isEnvelope(parsed)) return false;
  try {
    importSettlementState(parsed.settlement);
    importActivityState(parsed.activity);
    importOracleState(parsed.oracle);
    importCreatedMarkets(parsed.created);
    // Optional: envelopes written before the breaker existed simply leave it closed.
    if (parsed.breaker) importBreakerState(parsed.breaker);
    if (Array.isArray(parsed.quarantine)) importQuarantine(parsed.quarantine);
    importReleasedMarkets(Array.isArray(parsed.quarantineReleased) ? parsed.quarantineReleased : []);
  } catch {
    return false;
  }
  markDemoSeeded();
  return true;
}

// ── Merge (pure over two envelopes) ─────────────────────────────────────────────────────────────
// Two serverless instances each hold a partial view of the same economy; the merge must make their
// writes commutative so neither clobbers the other. Every rule below picks a stable identity per
// collection and a deterministic winner per collision.

/** Stable cross-instance identity for a feed action — seqs are per-instance and CANNOT identify. */
function activityKey(a: AgentAction): string {
  return `${a.ts}|${a.agent}|${a.marketId}|${a.kind}`;
}

function mergeActivity(local: ActivitySnapshot, remote: ActivitySnapshot): ActivitySnapshot {
  const byKey = new Map<string, AgentAction>();
  // Remote first, so on identity collisions this instance's copy of the action wins.
  for (const a of [...remote.actions, ...local.actions]) byKey.set(activityKey(a), a);
  const actions = [...byKey.values()]
    .sort((x, y) => y.ts - x.ts || y.seq - x.seq)
    .slice(0, ACTIVITY_CAP);
  // max() is the whole 42→5 fix: the round counter must never regress below either writer's.
  return { counter: Math.max(local.counter, remote.counter), actions };
}

function safeBig(x: unknown): bigint {
  try {
    return BigInt(String(x));
  } catch {
    return 0n;
  }
}

/** Settled beats unsettled (a resolution is never un-resolved); between two unsettled views of the
 * same market the one holding more escrowed stake wins — stakes only ever grow, so the bigger
 * total is the more recent view. Ties keep local. */
function pickLedgerEntry(local: LedgerEntry, remote: LedgerEntry): LedgerEntry {
  const localSettled = local.settlement !== null;
  if (localSettled !== (remote.settlement !== null)) return localSettled ? local : remote;
  return safeBig(remote.market?.totalStakedMotes) > safeBig(local.market?.totalStakedMotes) ? remote : local;
}

function mergeSettlement(local: SettlementSnapshot, remote: SettlementSnapshot): SettlementSnapshot {
  const byId = new Map<string, LedgerEntry>(remote.entries);
  for (const [marketId, entry] of local.entries) {
    const other = byId.get(marketId);
    byId.set(marketId, other ? pickLedgerEntry(entry, other) : entry);
  }
  return { entries: [...byId.entries()] };
}

function mergeOracle(local: OracleSnapshot, remote: OracleSnapshot): OracleSnapshot {
  const reputations = new Map<string, OracleReputationState>();
  for (const [id, rep] of [...remote.reputations, ...local.reputations]) {
    const other = reputations.get(id);
    if (!other) {
      reputations.set(id, rep);
      continue;
    }
    // Counts only ever grow, so the larger track record is the fresher one; accuracy breaks ties.
    const better =
      rep.resolved !== other.resolved
        ? rep.resolved > other.resolved
          ? rep
          : other
        : rep.accurate > other.accurate
          ? rep
          : other;
    reputations.set(id, better);
  }
  return {
    reputations: [...reputations.entries()],
    // The union keeps every (oracle, market) idempotence key: neither writer's resolution can be
    // recorded twice after the merge lands everywhere.
    recorded: [...new Set([...remote.recorded, ...local.recorded])],
  };
}

function mergeCreated(local: CreatedMarketsSnapshot, remote: CreatedMarketsSnapshot): CreatedMarketsSnapshot {
  const seen = new Set<string>();
  const created: MarketDefinition[] = [];
  // Remote first: both lists share the common-ancestor prefix, so this keeps creation order and
  // appends only this instance's genuinely new launches.
  for (const def of [...remote.created, ...local.created]) {
    if (seen.has(def.slug)) continue;
    seen.add(def.slug);
    created.push(def);
  }
  return { created };
}

/** The newest observable evidence on a breaker side — a trip, a failure, or a proven placement. */
function breakerEvidenceTs(b: BreakerSnapshot): number {
  return Math.max(b.trippedAt ?? 0, b.lastFailure?.ts ?? 0, b.clearedAt ?? 0);
}

function mergeBreaker(local?: BreakerSnapshot, remote?: BreakerSnapshot): BreakerSnapshot | undefined {
  if (!local) return remote;
  if (!remote) return local;
  const localTs = breakerEvidenceTs(local);
  const remoteTs = breakerEvidenceTs(remote);
  if (localTs !== remoteTs) return localTs > remoteTs ? local : remote;
  // Tie (or neither side has ever stamped anything): keep the side holding failures — a spurious
  // halt costs a tick, a spurious clear repeats a money-losing bet.
  return (remote.consecutiveFailures ?? 0) > (local.consecutiveFailures ?? 0) ? remote : local;
}

interface QuarantineView {
  active: QuarantinedMarket[];
  released: [string, number][];
}

/** Per slug the newest event wins: a quarantine entry strictly newer than the last release stays
 * active (keeping the FIRST diagnosis of that epoch); otherwise the release stands. A release ties
 * with an entry at the same ts — releases are deliberate operator actions, quarantines automatic. */
function mergeQuarantine(local: QuarantineView, remote: QuarantineView): QuarantineView {
  const releasedAt = new Map<string, number>();
  for (const [slug, ts] of [...remote.released, ...local.released]) {
    if (typeof slug !== "string" || typeof ts !== "number") continue;
    releasedAt.set(slug, Math.max(ts, releasedAt.get(slug) ?? ts));
  }
  const active = new Map<string, QuarantinedMarket>();
  for (const entry of [...remote.active, ...local.active]) {
    const cutoff = releasedAt.get(entry.slug);
    if (cutoff !== undefined && entry.ts <= cutoff) continue;
    const other = active.get(entry.slug);
    if (!other || entry.ts < other.ts) active.set(entry.slug, entry);
  }
  return {
    active: [...active.values()].sort((a, b) => a.ts - b.ts),
    released: [...releasedAt.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  };
}

/**
 * Merge two economy envelopes into one that loses neither writer's work. Pure; exported for tests.
 * `savedAt`/`rev` are the caller's to stamp — the merge only unions the five state collections.
 */
export function mergeEconomyEnvelopes(local: EconomyEnvelope, remote: EconomyEnvelope): EconomyEnvelope {
  const quarantine = mergeQuarantine(
    { active: local.quarantine ?? [], released: local.quarantineReleased ?? [] },
    { active: remote.quarantine ?? [], released: remote.quarantineReleased ?? [] },
  );
  return {
    v: 1,
    savedAt: local.savedAt,
    settlement: mergeSettlement(local.settlement, remote.settlement),
    activity: mergeActivity(local.activity, remote.activity),
    oracle: mergeOracle(local.oracle, remote.oracle),
    created: mergeCreated(local.created, remote.created),
    breaker: mergeBreaker(local.breaker, remote.breaker),
    quarantine: quarantine.active,
    quarantineReleased: quarantine.released,
  };
}

// ── KV transport ────────────────────────────────────────────────────────────────────────────────

/** Run one KV request under a hard timeout so a hung KV endpoint can never hang a route. */
async function withTimeout(run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

let hydrated = false;
let hydrating: Promise<void> | null = null;

/**
 * Hydrate the economy from KV, once per instance. Callers MUST await this before their first read
 * (the mock store's port methods and the read routes do). Unconfigured → instant no-op. Errors
 * (network, timeout, bad payload) are warned once and swallowed — the app must never die from KV
 * downtime; it just serves this instance's in-memory state.
 */
export function hydrateEconomyState(fetchImpl?: typeof fetch): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydrating) return hydrating;
  const cfg = kvConfig();
  if (!cfg) {
    hydrated = true; // unconfigured is a terminal state for this instance — don't re-check per read
    return Promise.resolve();
  }
  hydrating = (async () => {
    try {
      const res = await withTimeout((signal) =>
        (fetchImpl ?? fetch)(`${cfg.url}/get/${encodeURIComponent(ECONOMY_KV_KEY)}`, {
          headers: { Authorization: `Bearer ${cfg.token}` },
          // Next.js patches fetch with a cache; a stale snapshot would resurrect vanished bets.
          cache: "no-store",
          signal,
        }),
      );
      if (res.ok) {
        const body = (await res.json()) as { result?: string | null };
        // `result: null` = key never written yet (fresh deployment) — nothing to apply.
        if (typeof body?.result === "string") applyEconomyState(body.result);
      } else {
        console.warn(`[economy-state] KV hydrate returned ${res.status} — continuing with in-memory state`);
      }
    } catch (err) {
      console.warn("[economy-state] KV hydrate failed — continuing with in-memory state:", err);
    } finally {
      hydrated = true; // even on failure: one attempt per instance, no retry storm on every read
      hydrating = null;
    }
  })();
  return hydrating;
}

/**
 * Force a FRESH hydrate, discarding the once-per-instance guard. For writers whose output
 * clobbers the whole envelope — today that is the tick, the economy's biggest writer.
 *
 * Why: `hydrateEconomyState` runs once per instance, and `persistEconomyState` writes the whole
 * envelope last-writer-wins. A warm instance that hydrated long ago therefore persists its STALE
 * view over every write other instances made since — observed live 2026-07-20, when a tick reset
 * the round counter from 42 to 5 and truncated the activity history. Re-hydrating at tick start
 * shrinks that clobber window from "instance age" to "one tick". Safe because every mutating
 * route now awaits its own flush, so instance memory holds nothing unpersisted worth keeping.
 * (The race that remained — two writers interleaving inside one tick — is closed by
 * merge-on-persist + compare-and-set in `persistEconomyState`; this fresh read is now about
 * serving a current view during the tick, not about write safety.)
 */
export function rehydrateEconomyState(fetchImpl?: typeof fetch): Promise<void> {
  if (hydrating) return hydrating; // a fetch is in flight — its result is already fresh
  hydrated = false;
  return hydrateEconomyState(fetchImpl);
}

/**
 * Liveness probe for the operator health surface: is the configured KV endpoint actually
 * reachable and authorized *right now*? Distinct from `persistenceConfigured()` (which only
 * reads env) because the classic ops failure is a token that was rotated in the KV dashboard
 * but not in the deploy — env looks perfect, every write silently 401s, and the boards quietly
 * stop surviving cold starts.
 *
 * Never throws, never mutates state, and never returns the URL or token — only a verdict, an
 * HTTP status when there is one, and a latency. Uses the same hard timeout as the real traffic.
 */
export async function probePersistence(
  fetchImpl?: typeof fetch,
): Promise<{ configured: boolean; reachable: boolean; status?: number; latencyMs?: number; error?: string }> {
  const cfg = kvConfig();
  if (!cfg) return { configured: false, reachable: false };
  const started = Date.now();
  try {
    const res = await withTimeout((signal) =>
      (fetchImpl ?? fetch)(`${cfg.url}/get/${encodeURIComponent(ECONOMY_KV_KEY)}`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
        cache: "no-store",
        signal,
      }),
    );
    return { configured: true, reachable: res.ok, status: res.status, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let dirty = false;
let writer: Promise<void> | null = null;
let warnedWrite = false;
let casUnsupported = false;

/** How many GET→merge→CAS rounds one write cycle attempts before failing open to a plain SET. */
const CAS_MAX_ATTEMPTS = 3;

/**
 * Upstash-compatible compare-and-set: SET the envelope only if the stored `rev` still equals
 * ARGV[1]. A missing key counts as rev 0; an unparseable stored document also counts as rev 0
 * (overwriting corruption heals it, wedging on it would kill persistence forever). Returns 1 on
 * write, 0 on conflict.
 */
const CAS_LUA =
  "local cur = redis.call('GET', KEYS[1]) " +
  "if cur == false then if ARGV[1] == '0' then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0 end " +
  "local ok, doc = pcall(cjson.decode, cur) " +
  "local rev = 0 " +
  "if ok and type(doc) == 'table' and type(doc.rev) == 'number' then rev = doc.rev end " +
  "if tostring(rev) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end " +
  "return 0";

type RemoteRead = { kind: "ok"; envelope: EconomyEnvelope } | { kind: "empty" } | { kind: "unavailable" };

/** Read + validate the stored envelope for a merge. "empty" also covers a corrupt or foreign
 * payload (overwriting heals it — matching the Lua script, which treats both as rev 0);
 * "unavailable" means KV itself failed and the caller must fail open to a plain write. */
async function readRemoteEnvelope(cfg: KvConfig, fetchImpl?: typeof fetch): Promise<RemoteRead> {
  try {
    const res = await withTimeout((signal) =>
      (fetchImpl ?? fetch)(`${cfg.url}/get/${encodeURIComponent(ECONOMY_KV_KEY)}`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
        cache: "no-store",
        signal,
      }),
    );
    if (!res.ok) return { kind: "unavailable" };
    const body = (await res.json()) as { result?: string | null };
    if (typeof body?.result !== "string") return { kind: "empty" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.result);
    } catch {
      return { kind: "empty" };
    }
    return isEnvelope(parsed) ? { kind: "ok", envelope: parsed } : { kind: "empty" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** One guarded write. "unsupported" = the server rejected EVAL (latch it off for this instance);
 * "error" = transport trouble (do NOT latch — it may be a blip). Both fall open to a plain SET. */
async function casSet(
  cfg: KvConfig,
  fetchImpl: typeof fetch | undefined,
  expectedRev: number,
  payload: string,
): Promise<"written" | "conflict" | "unsupported" | "error"> {
  try {
    const res = await withTimeout((signal) =>
      (fetchImpl ?? fetch)(cfg.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["EVAL", CAS_LUA, 1, ECONOMY_KV_KEY, String(expectedRev), payload]),
        signal,
      }),
    );
    if (!res.ok) return "unsupported";
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    if (body?.error !== undefined) return "unsupported";
    return Number(body?.result) === 1 ? "written" : "conflict";
  } catch {
    return "error";
  }
}

/** The unguarded last-writer-wins SET — the fail-open floor every guard above degrades to. */
async function plainSet(cfg: KvConfig, fetchImpl: typeof fetch | undefined, payload: string): Promise<void> {
  try {
    const res = await withTimeout((signal) =>
      (fetchImpl ?? fetch)(cfg.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["SET", ECONOMY_KV_KEY, payload]),
        signal,
      }),
    );
    if (!res.ok && !warnedWrite) {
      warnedWrite = true;
      console.warn(`[economy-state] KV persist returned ${res.status} — state stays in-memory only`);
    }
  } catch (err) {
    if (!warnedWrite) {
      warnedWrite = true;
      console.warn("[economy-state] KV persist failed — state stays in-memory only:", err);
    }
  }
}

/**
 * Snapshot the economy to KV. Debounced/coalesced: all calls in the same tick share ONE in-flight
 * write (the writer yields a microtask first so every same-tick mutation lands in the snapshot),
 * and a mutation arriving during a write re-queues exactly one follow-up write. Unconfigured →
 * instant no-op. Failures are warned once per instance and swallowed. Fire-and-forget from
 * mutation paths (`void persistEconomyState()`); the tick route awaits it so the cron's state is
 * flushed before the lambda freezes.
 *
 * Every write is merge-on-persist under optimistic concurrency:
 *
 *   1. GET the stored envelope;
 *   2. merge it into memory (synchronously — nothing can interleave between the snapshot, the
 *      merge, and the import) so this instance adopts the union it is about to publish;
 *   3. compare-and-set the union against the rev it merged with, re-reading and re-merging on a
 *      conflict, bounded by CAS_MAX_ATTEMPTS.
 *
 * Fail-open ladder, in order: KV read down → plain SET of local state; EVAL rejected → plain SET
 * of the merged union (and stop attempting CAS on this instance); CAS transport error → plain SET
 * of the merged union; conflicts exhausted → plain SET of current memory (which already absorbed
 * every merge attempt). KV downtime therefore degrades exactly to the old last-writer-wins write —
 * it never blocks or drops a flush.
 */
export function persistEconomyState(fetchImpl?: typeof fetch): Promise<void> {
  const cfg = kvConfig();
  if (!cfg) return Promise.resolve();
  dirty = true;
  if (writer) return writer; // coalesce: the running writer will pick this mutation up via `dirty`
  writer = (async () => {
    try {
      await Promise.resolve(); // yield one microtask so same-tick mutations share one snapshot
      while (dirty) {
        dirty = false;
        let written = false;
        for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS && !written; attempt++) {
          const remote = await readRemoteEnvelope(cfg, fetchImpl);
          if (remote.kind === "unavailable") break; // fail open to the plain write below
          // Snapshot → merge → import → serialize is one synchronous block: mutations that landed
          // during the GET above are inside `currentEnvelope()`, and nothing can interleave before
          // the import. Clearing `dirty` here is therefore safe — everything mutated so far is in
          // this payload; only mutations during the write await below re-queue a cycle.
          dirty = false;
          const expectedRev = remote.kind === "ok" ? (remote.envelope.rev ?? 0) : 0;
          const envelope =
            remote.kind === "ok" ? mergeEconomyEnvelopes(currentEnvelope(), remote.envelope) : currentEnvelope();
          envelope.savedAt = new Date().toISOString();
          envelope.rev = expectedRev + 1;
          const payload = JSON.stringify(envelope);
          if (remote.kind === "ok") applyEconomyState(payload); // memory adopts the union it publishes
          if (casUnsupported) {
            await plainSet(cfg, fetchImpl, payload);
            written = true;
            break;
          }
          const cas = await casSet(cfg, fetchImpl, expectedRev, payload);
          if (cas === "written") {
            written = true;
          } else if (cas === "conflict") {
            continue; // someone landed between our GET and SET — re-read, re-merge, retry
          } else {
            if (cas === "unsupported") casUnsupported = true; // the server said no — stop asking
            await plainSet(cfg, fetchImpl, payload);
            written = true;
          }
        }
        if (!written) {
          // KV read down or conflicts exhausted: degrade to the pre-merge behaviour. Memory holds
          // every union the attempts above managed to apply, so this is still the richest view.
          dirty = false;
          await plainSet(cfg, fetchImpl, serializeEconomyState());
        }
      }
    } finally {
      writer = null;
    }
  })();
  return writer;
}

/** Test-only: reset the once-per-instance hydration + write-coalescing guards. */
export function __resetPersistenceForTests(): void {
  hydrated = false;
  hydrating = null;
  dirty = false;
  writer = null;
  warnedWrite = false;
  casUnsupported = false;
}

// ── Hook registration (module load) ─────────────────────────────────────────────────────────────
// The state modules fire `fireEconomyPersistHook()` after each mutation; wiring the hook here (the
// only module that may import all of them) keeps the import graph acyclic. Loading any consumer of
// this module (the mock store, the read routes, the tick) arms persistence for the whole instance.
setEconomyPersistHook(() => {
  void persistEconomyState();
});
