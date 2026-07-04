/**
 * Deterministic mock LlmClient. Returns canned, plausible narration so the swarm demo works
 * offline and tests stay stable. The real client routes through a provider behind this same
 * interface — and its output remains advisory-only, never the money authority.
 */

import type { LlmClient, LlmCompleteInput } from "@/ports/llm";

export function createMockLlm(): LlmClient {
  return {
    async complete(input: LlmCompleteInput): Promise<string> {
      const p = input.prompt.toLowerCase();
      if (p.includes("rationale") || p.includes("why")) {
        return "Momentum is positive and the pool is under-pricing the move — taking the favored side.";
      }
      if (p.includes("market idea") || p.includes("propose")) {
        return "CSPR staking APY above 11% by month-end — timely and cleanly resolvable via CSPR.cloud.";
      }
      if (p.includes("resolution") || p.includes("summary")) {
        return "Criterion met at the deadline snapshot; resolving to the affirmative outcome.";
      }
      return "Acknowledged.";
    },
  };
}
