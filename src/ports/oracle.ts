/**
 * OraclePort — how Arbiter reads the world and how the app queries oracle reputation.
 *
 * The reputation score is the RWA-oracle thesis: because a wrong resolution costs bettors
 * real money, accuracy has economic teeth. Reputation is written on-chain by the
 * OracleRegistry contract; this port reads it and produces resolution readings.
 */

export interface OracleReading {
  marketId: string;
  winningOutcomeKey: string;
  /** Plain-English rationale (LLM-authored, advisory — never the money authority). */
  rationale: string;
  observedAtIso: string;
  /**
   * Whether this reading was later confirmed accurate against ground truth. Undefined ⇒ treated as
   * accurate (the deterministic reader agrees with reality). The mock marks a deterministic minority
   * of readings inaccurate so the Arbiter's reputation moves BOTH ways — the RWA-oracle thesis has
   * real, two-sided risk (a wrong call drops accuracy, and `arbiter-accuracy-95` can resolve NO).
   * The real adapter sets this from a dispute/confirmation layer.
   */
  accurate?: boolean;
}

export interface OracleReputation {
  oracleId: string;
  /** Human-readable oracle name. */
  name: string;
  /** Historical resolution accuracy in [0, 1]. */
  accuracy: number;
  /** Accuracy in basis points (floored) — the exact on-chain `accuracy_bps`. */
  accuracyBps: number;
  /** Number of markets resolved. */
  resolvedCount: number;
  /** Of those, how many were confirmed accurate. */
  accurateCount: number;
}

export interface OraclePort {
  /** Determine the winning outcome for a market from off-chain data. */
  read(marketId: string): Promise<OracleReading>;
  reputationOf(oracleId: string): Promise<OracleReputation>;
  /** Record a resolution's accuracy against an oracle — updates its reputation. Idempotent per market. */
  recordResolution(oracleId: string, marketId: string, accurate: boolean): Promise<OracleReputation>;
  /** Every known oracle's reputation, ranked by accuracy — the oracle-accuracy leaderboard. */
  leaderboard(): Promise<OracleReputation[]>;
}
