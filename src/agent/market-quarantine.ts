/**
 * Market quarantine — stop paying for a bet the chain will always reject.
 *
 * The breaker (`bet-breaker.ts`) answers "the money path is broken everywhere". This answers the
 * narrower and nastier case: the money path is fine, but ONE market is misconfigured — its
 * catalogue entry and the contract it routes to disagree — so a bet on it reverts every single
 * time. The fleet picks its target by `seq % openMarkets.length`, so a single bad market is not a
 * one-off: it comes back around on a fixed cycle and charges a full stake each time, forever, while
 * every other market keeps working and the breaker never trips (the failures are not consecutive).
 *
 * Found in production: `coin-flip-5m` routed to a per-market package that rejects BOTH of its
 * catalogue outcomes with `UnknownOutcome`. Twelve other markets bet fine.
 *
 * Only the contract-level reverts that are PERMANENT for a slug quarantine it:
 *
 *   - `UnknownOutcome` (3) — the app offers an outcome this contract does not have
 *   - `UnknownMarket` (12) — the vault has no market under this id
 *
 * Both mean "config, not weather". A transport failure, a timeout, an out-of-gas or a closed
 * market must NOT quarantine anything — those are transient or expected, and quarantining on them
 * would let a blip silently shrink the catalogue.
 */

export interface QuarantinedMarket {
  slug: string;
  reason: string;
  /** The settlement the agent paid before this was discovered — the loss to reconcile. */
  deployHash: string;
  ts: number;
}

const quarantined = new Map<string, QuarantinedMarket>();

/**
 * Release tombstones: slug → epoch ms of the operator release. Without them, the cross-instance
 * merge cannot tell "released" from "never quarantined", and a stale writer still holding the
 * quarantine would silently resurrect it — making an operator release impossible to land.
 */
const released = new Map<string, number>();

/** Bound the tombstone list so the KV envelope can never grow without limit. */
const RELEASED_CAP = 200;

function rememberRelease(slug: string, ts: number): void {
  released.set(slug, Math.max(ts, released.get(slug) ?? 0));
  if (released.size > RELEASED_CAP) {
    const oldest = [...released.entries()].sort((a, b) => a[1] - b[1]).slice(0, released.size - RELEASED_CAP);
    for (const [s] of oldest) released.delete(s);
  }
}

/**
 * Odra revert codes that mean this market is permanently unbettable as configured. Matched against
 * the chain's own `User error: N` message, which is what surfaces through the submit error.
 */
const PERMANENT_REVERTS: ReadonlyArray<{ code: number; name: string }> = [
  { code: 3, name: "UnknownOutcome" },
  { code: 12, name: "UnknownMarket" },
];

/**
 * Does this failure mean the market is misconfigured (rather than merely unlucky)? PURE, so the
 * classification is testable without a chain.
 */
export function permanentMarketFault(message: string): string | null {
  const match = /User error:\s*(\d+)/.exec(message);
  if (!match) return null;
  const code = Number(match[1]);
  const known = PERMANENT_REVERTS.find((r) => r.code === code);
  return known ? known.name : null;
}

/** Quarantine a slug. Idempotent — the FIRST diagnosis is kept, not the latest. */
export function quarantineMarket(entry: QuarantinedMarket): void {
  if (quarantined.has(entry.slug)) return;
  quarantined.set(entry.slug, entry);
  released.delete(entry.slug); // the local timeline is authoritative: this quarantine post-dates any local release
}

export function isQuarantined(slug: string): boolean {
  return quarantined.has(slug);
}

export function quarantinedMarkets(): QuarantinedMarket[] {
  return [...quarantined.values()];
}

/** Operator action after fixing the routing/catalogue — nothing releases a market on its own. */
export function releaseMarket(slug: string): boolean {
  const removed = quarantined.delete(slug);
  if (removed) rememberRelease(slug, Date.now());
  return removed;
}

export function releaseAllMarkets(): void {
  const now = Date.now();
  for (const slug of quarantined.keys()) rememberRelease(slug, now);
  quarantined.clear();
}

/** Snapshot for the KV envelope — quarantine must outlive a serverless instance. */
export function exportQuarantine(): QuarantinedMarket[] {
  return quarantinedMarkets();
}

export function importQuarantine(entries: QuarantinedMarket[]): void {
  quarantined.clear();
  for (const e of entries) {
    if (e && typeof e.slug === "string" && e.slug.length > 0) quarantined.set(e.slug, e);
  }
}

/** Release tombstones for the KV envelope — `[slug, releasedAt]` pairs. */
export function exportReleasedMarkets(): [string, number][] {
  return [...released.entries()];
}

/** Restore tombstones, REPLACING current ones. Malformed entries are dropped, never thrown on. */
export function importReleasedMarkets(entries: [string, number][]): void {
  released.clear();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (Array.isArray(e) && typeof e[0] === "string" && e[0].length > 0 && typeof e[1] === "number") {
      released.set(e[0], e[1]);
    }
  }
}

/** Test-only: clear active quarantines AND release tombstones. */
export function __resetQuarantine(): void {
  quarantined.clear();
  released.clear();
}
