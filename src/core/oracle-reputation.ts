/**
 * Pure oracle-reputation accounting — the off-chain mirror of the on-chain `OracleRegistry`
 * (`contracts/src/oracle_registry.rs`). Reputation is deterministic counting, never an LLM: a
 * resolution is recorded as accurate or not, and accuracy is `accurate / resolved` in basis
 * points, floored — exactly the contract's `accuracy_bps`. This is the RWA-oracle thesis in
 * code: because a wrong resolution costs bettors money, this score has economic teeth.
 */

export interface OracleReputationState {
  oracleId: string;
  /** Human-readable oracle name. */
  name: string;
  /** Total resolutions recorded. */
  resolved: number;
  /** Of those, how many were confirmed accurate. */
  accurate: number;
}

/** Running accuracy in basis points (0 when nothing resolved) — floored, matching the contract. */
export function accuracyBps(accurate: number, resolved: number): number {
  if (resolved <= 0) return 0;
  return Math.floor((accurate * 10_000) / resolved);
}

/** Accuracy as a percentage number, e.g. 96.09. */
export function accuracyPct(state: OracleReputationState): number {
  return accuracyBps(state.accurate, state.resolved) / 100;
}

/** Fold one resolution into a reputation state (pure). */
export function recordResolution(state: OracleReputationState, accurate: boolean): OracleReputationState {
  return {
    ...state,
    resolved: state.resolved + 1,
    accurate: state.accurate + (accurate ? 1 : 0),
  };
}
