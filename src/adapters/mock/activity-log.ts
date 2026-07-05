/**
 * In-process agent-activity log — the feed behind the live `/agents` dashboard. Genesis, the
 * Prophets, and the Arbiter append an action as they act; the UI renders them newest-first. A
 * module-level ring buffer (like the other mock ledgers); the real feed indexes on-chain events
 * via CSPR.cloud behind the same read shape.
 */

import { ensureDemoSeed } from "./demo-seed";

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
