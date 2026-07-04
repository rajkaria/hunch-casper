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
}

export interface OracleReputation {
  oracleId: string;
  /** Historical resolution accuracy in [0, 1]. */
  accuracy: number;
  /** Number of markets resolved. */
  resolvedCount: number;
}

export interface OraclePort {
  /** Determine the winning outcome for a market from off-chain data. */
  read(marketId: string): Promise<OracleReading>;
  reputationOf(oracleId: string): Promise<OracleReputation>;
}
