/**
 * Deterministic mock OraclePort. Picks a winning outcome by a stable hash of the market id
 * (so tests are reproducible) and returns a canned reputation. The real Arbiter adapter reads
 * CSPR.cloud / price feeds and writes reputation to the OracleRegistry contract.
 */

import type { OraclePort, OracleReading, OracleReputation } from "@/ports/oracle";
import { buildCatalogue } from "@/core/catalogue";
import { pseudoDeployHash } from "./mock-chain";

function stablePick(marketId: string, outcomeKeys: string[]): string {
  const hash = pseudoDeployHash(`oracle:${marketId}`);
  const n = parseInt(hash.slice(0, 8), 16);
  return outcomeKeys[n % outcomeKeys.length];
}

export function createMockOracle(): OraclePort {
  return {
    async read(marketId: string): Promise<OracleReading> {
      // Derive outcome keys from the catalogue slug embedded in the id (`network:slug`).
      const slug = marketId.includes(":") ? marketId.split(":")[1] : marketId;
      const def = buildCatalogue("testnet").find((m) => m.slug === slug);
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
      return { oracleId, accuracy: 0.96, resolvedCount: 128 };
    },
  };
}
