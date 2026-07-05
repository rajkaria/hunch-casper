/**
 * In-process agent-activity log — the feed behind the live `/agents` dashboard. Genesis, the
 * Prophets, and the Arbiter append an action as they act; the UI renders them newest-first. A
 * module-level ring buffer (like the other mock ledgers); the real feed indexes on-chain events
 * via CSPR.cloud behind the same read shape.
 */

import { ensureDemoSeed } from "./demo-seed";
import { fireEconomyPersistHook } from "@/adapters/persist/economy-persist-hook";

export type AgentActionKind = "market_created" | "bet_placed" | "market_resolved";

export interface AgentAction {
  /** Monotone id, newest-highest. */
  seq: number;
  /** The acting agent's display name (e.g. "Genesis", "Momentum", "Arbiter"). */
  agent: string;
  kind: AgentActionKind;
  marketId: string;
  marketTitle?: string;
  outcomeKey?: string;
  amountMotes?: string;
  /** LLM narration — advisory flavour, never the money path. */
  narration?: string;
  deployHash?: string;
  explorerUrl?: string;
  /**
   * Whether the deploy hash is simulated (mock chain / demo seed) rather than a real on-chain
   * transaction. The feed renders simulated hashes with a "simulated" chip and never links them
   * to the live explorer (a pseudo hash would land a judge on "transaction not found").
   */
  simulated?: boolean;
  /** Epoch ms the action was recorded — the feed renders it as relative time ("2m ago"). */
  ts: number;
}

const CAP = 60;
const log: AgentAction[] = [];
let counter = 0;

/** Append an action and return it (with its assigned seq + timestamp). Newest actions sort first. */
export function appendAction(action: Omit<AgentAction, "seq" | "ts"> & { ts?: number }): AgentAction {
  const withSeq: AgentAction = { ...action, seq: counter++, ts: action.ts ?? Date.now() };
  log.unshift(withSeq);
  if (log.length > CAP) log.length = CAP;
  fireEconomyPersistHook(); // snapshot to KV when configured (no-op otherwise) — see adapters/persist
  return withSeq;
}

/** The most recent actions, newest first. Seeds a deterministic demo feed on a cold instance. */
export function listActions(limit = 50): AgentAction[] {
  if (log.length === 0) ensureDemoSeed();
  return log.slice(0, limit);
}

/** Test-only: clear the activity feed. */
export function __resetActivity(): void {
  log.length = 0;
  counter = 0;
}

/** JSON-safe snapshot of the FULL feed state — the ring buffer AND the seq counter, so actions
 * appended after a restore never collide with restored seqs. For KV persistence. */
export interface ActivitySnapshot {
  counter: number;
  actions: AgentAction[];
}

/** Export the feed, cloned so later appends never leak into a captured snapshot. */
export function exportActivityState(): ActivitySnapshot {
  return { counter, actions: log.map((a) => ({ ...a })) };
}

/** Restore a snapshot, REPLACING (not merging) current state. Idempotent. */
export function importActivityState(snapshot: ActivitySnapshot): void {
  log.length = 0;
  for (const a of snapshot.actions) log.push({ ...a });
  if (log.length > CAP) log.length = CAP;
  counter = snapshot.counter;
}
