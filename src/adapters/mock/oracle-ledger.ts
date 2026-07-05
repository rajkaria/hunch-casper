/**
 * In-process oracle-reputation ledger — the mutable state behind the mock `OraclePort`'s
 * reputation, the off-chain mirror of the on-chain `OracleRegistry`. It seeds the Arbiter with a
 * prior track record (so the reputation is a real number, not a flat 100%) and folds in each new
 * resolution through the pure `oracle-reputation` accounting. Module-level singleton, like the
 * settlement ledger, so a resolution visibly moves the accuracy; the chain registry is the source
 * of truth and the real Supabase/CSPR.cloud-indexed adapter drops in behind the same port.
 */

import type { OracleReputationState } from "@/core/oracle-reputation";
import { recordResolution } from "@/core/oracle-reputation";
import { fireEconomyPersistHook } from "@/adapters/persist/economy-persist-hook";

/** The Arbiter's seeded track record: 123/128 ≈ 96.09% accuracy going into the buildathon. */
const ARBITER_BASELINE: OracleReputationState = {
  oracleId: "arbiter",
  name: "Arbiter",
  resolved: 128,
  accurate: 123,
};

const ledger = new Map<string, OracleReputationState>();
/** `${oracleId}:${marketId}` — a resolution counts at most once (matches the contract). */
const recorded = new Set<string>();

function ensure(oracleId: string): OracleReputationState {
  const existing = ledger.get(oracleId);
  if (existing) return existing;
  const seeded: OracleReputationState =
    oracleId === "arbiter"
      ? { ...ARBITER_BASELINE }
      : { oracleId, name: oracleId.replace(/^\w/, (c) => c.toUpperCase()), resolved: 0, accurate: 0 };
  ledger.set(oracleId, seeded);
  return seeded;
}

/** The current reputation for an oracle (seeding the Arbiter baseline on first read). */
export function oracleReputationOf(oracleId: string): OracleReputationState {
  return { ...ensure(oracleId) };
}

/**
 * Every known oracle's reputation, ranked by accuracy (desc) then most-resolved — the
 * oracle-accuracy leaderboard. The Arbiter is always present (seeded on first read) so the board
 * is never empty even before the first live resolution.
 */
export function listOracleReputations(): OracleReputationState[] {
  ensure("arbiter"); // guarantee the Arbiter appears even on a cold start
  return [...ledger.values()]
    .map((s) => ({ ...s }))
    .sort((a, b) => {
      const accA = a.resolved > 0 ? a.accurate / a.resolved : 0;
      const accB = b.resolved > 0 ? b.accurate / b.resolved : 0;
      if (accA !== accB) return accB - accA;
      if (a.resolved !== b.resolved) return b.resolved - a.resolved;
      return a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0;
    });
}

/** Record one resolution's accuracy against an oracle. Idempotent per (oracle, market). */
export function oracleRecordResolution(
  oracleId: string,
  marketId: string,
  accurate: boolean,
): OracleReputationState {
  const key = `${oracleId}:${marketId}`;
  const current = ensure(oracleId);
  if (recorded.has(key)) return { ...current };
  recorded.add(key);
  const updated = recordResolution(current, accurate);
  ledger.set(oracleId, updated);
  fireEconomyPersistHook(); // snapshot to KV when configured (no-op otherwise) — see adapters/persist
  return { ...updated };
}

/** Test-only: clear all in-process reputation state. */
export function __resetOracleLedger(): void {
  ledger.clear();
  recorded.clear();
}

/** JSON-safe snapshot of the FULL oracle state (Map → entries, Set → array) for KV persistence.
 * The `recorded` idempotence keys ride along so a restored instance still counts each
 * (oracle, market) resolution at most once. */
export interface OracleSnapshot {
  reputations: [string, OracleReputationState][];
  recorded: string[];
}

/** Export the oracle ledger, cloned so later resolutions never leak into a captured snapshot. */
export function exportOracleState(): OracleSnapshot {
  return {
    reputations: Array.from(ledger.entries(), ([id, s]): [string, OracleReputationState] => [id, { ...s }]),
    recorded: [...recorded],
  };
}

/** Restore a snapshot, REPLACING (not merging) current state. Idempotent. */
export function importOracleState(snapshot: OracleSnapshot): void {
  ledger.clear();
  recorded.clear();
  for (const [id, s] of snapshot.reputations) ledger.set(id, { ...s });
  for (const key of snapshot.recorded) recorded.add(key);
}
