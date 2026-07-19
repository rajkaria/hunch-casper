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
 *     one more write. Across instances it is last-write-wins — acceptable because the cron tick is
 *     effectively a single writer and this is demo-grade durability, not the money path (the chain
 *     stays the source of truth for money).
 */

import {
  exportSettlementState,
  importSettlementState,
  type SettlementSnapshot,
} from "@/adapters/mock/settlement-ledger";
import {
  exportActivityState,
  importActivityState,
  type ActivitySnapshot,
} from "@/adapters/mock/activity-log";
import {
  exportOracleState,
  importOracleState,
  type OracleSnapshot,
} from "@/adapters/mock/oracle-ledger";
import {
  exportCreatedMarkets,
  importCreatedMarkets,
  type CreatedMarketsSnapshot,
} from "@/adapters/mock/market-source";
import {
  exportBreakerState,
  importBreakerState,
  type BreakerSnapshot,
} from "@/agent/bet-breaker";
import { markDemoSeeded } from "@/adapters/mock/demo-seed";
import { setEconomyPersistHook } from "@/adapters/persist/economy-persist-hook";

/** The single KV key the whole economy snapshot lives under. Versioned so a future envelope shape
 * can move to `:v2` without ever mis-parsing old data. */
export const ECONOMY_KV_KEY = "hunch:economy:v1";

const TIMEOUT_MS = 3_000;

/** The versioned envelope folding all four module snapshots into one JSON document. */
interface EconomyEnvelope {
  v: 1;
  /** ISO timestamp of the snapshot — diagnostic only (last-write-wins needs no clock logic). */
  savedAt: string;
  settlement: SettlementSnapshot;
  activity: ActivitySnapshot;
  oracle: OracleSnapshot;
  created: CreatedMarketsSnapshot;
  /** Optional: absent in envelopes written before the bet breaker existed. */
  breaker?: BreakerSnapshot;
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

/** Snapshot the whole economy into one versioned JSON envelope. */
export function serializeEconomyState(): string {
  const envelope: EconomyEnvelope = {
    v: 1,
    savedAt: new Date().toISOString(),
    settlement: exportSettlementState(),
    activity: exportActivityState(),
    oracle: exportOracleState(),
    created: exportCreatedMarkets(),
    breaker: exportBreakerState(),
  };
  return JSON.stringify(envelope);
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
  } catch {
    return false;
  }
  markDemoSeeded();
  return true;
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

/**
 * Snapshot the economy to KV. Debounced/coalesced: all calls in the same tick share ONE in-flight
 * write (the writer yields a microtask first so every same-tick mutation lands in the snapshot),
 * and a mutation arriving during a write re-queues exactly one follow-up write. Unconfigured →
 * instant no-op. Failures are warned once per instance and swallowed. Fire-and-forget from
 * mutation paths (`void persistEconomyState()`); the tick route awaits it so the cron's state is
 * flushed before the lambda freezes.
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
        const payload = serializeEconomyState();
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
}

// ── Hook registration (module load) ─────────────────────────────────────────────────────────────
// The state modules fire `fireEconomyPersistHook()` after each mutation; wiring the hook here (the
// only module that may import all of them) keeps the import graph acyclic. Loading any consumer of
// this module (the mock store, the read routes, the tick) arms persistence for the whole instance.
setEconomyPersistHook(() => {
  void persistEconomyState();
});
