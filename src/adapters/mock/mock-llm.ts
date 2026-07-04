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
      // Prophet narration — keyed off the strategy angle in the prompt so each agent has a voice.
      if (p.includes("favourite") || p.includes("favorite") || p.includes("riding the crowd")) {
        return "The crowd is converging and the pool confirms it — I'm riding the favourite before the line firms up.";
      }
      if (p.includes("longshot") || p.includes("fading the crowd")) {
        return "Everyone has piled onto the obvious side; the mispricing is on the longshot, so that is exactly where I am.";
      }
      if (p.includes("under-priced") || p.includes("value")) {
        return "The implied odds are lagging fair value here — this line is a gift and I'm taking it before it corrects.";
      }
      if (p.includes("chaos")) {
        return "Predictable is beatable. I'm taking the outcome nobody is watching, because the market least expects it.";
      }
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
