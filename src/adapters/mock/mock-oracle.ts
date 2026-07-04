/**
 * Deterministic mock OraclePort. Picks a winning outcome by a stable hash of the market id
 * (so tests are reproducible) and returns a canned reputation. The real Arbiter adapter reads
 * CSPR.cloud / price feeds and writes reputation to the OracleRegistry contract.
 */

import type { OraclePort, OracleReading, OracleReputation } from "@/ports/oracle";
import { findDefinition } from "@/adapters/mock/market-source";
import { accuracyBps as accuracyBpsOf } from "@/core/oracle-reputation";
import type { OracleReputationState } from "@/core/oracle-reputation";
import { oracleRecordResolution, oracleReputationOf } from "./oracle-ledger";
import { pseudoDeployHash } from "./mock-chain";

function toReputation(state: OracleReputationState): OracleReputation {
  const bps = accuracyBpsOf(state.accurate, state.resolved);
  return {
    oracleId: state.oracleId,
    name: state.name,
    accuracy: bps / 10_000,
    accuracyBps: bps,
    resolvedCount: state.resolved,
    accurateCount: state.accurate,
  };
}

function stablePick(marketId: string, outcomeKeys: string[]): string {
  const hash = pseudoDeployHash(`oracle:${marketId}`);
  const n = parseInt(hash.slice(0, 8), 16);
  return outcomeKeys[n % outcomeKeys.length];
}

export function createMockOracle(): OraclePort {
  return {
    async read(marketId: string): Promise<OracleReading> {
      // Derive outcome keys from the definition slug embedded in the id (`network:slug`).
      const slug = marketId.includes(":") ? marketId.split(":")[1] : marketId;
      const def = findDefinition(slug);
      const keys = def ? def.outcomes.map((o) => o.key) : ["yes", "no"];
      const winningOutcomeKey = stablePick(marketId, keys);
      return {
        marketId,
        winningOutcomeKey,
        rationale: `Resolved from observed data: "${winningOutcomeKey}" met the criterion.`,
        observedAtIso: "2026-08-01T00:00:00.000Z",
      };
    },
    async reputationOf(oracleId: string): Promise<OracleReputation> {
      return toReputation(oracleReputationOf(oracleId));
    },
    async recordResolution(oracleId: string, marketId: string, accurate: boolean): Promise<OracleReputation> {
      return toReputation(oracleRecordResolution(oracleId, marketId, accurate));
    },
  };
}
