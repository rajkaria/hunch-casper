/**
 * LlmClient — the ONLY way an LLM enters the system. Used for advisory work only:
 * market-idea generation (Genesis), bet rationale narration (Prophets), resolution
 * summaries (Arbiter). Its output NEVER flows into a money path — payouts are pure,
 * deterministic contract math.
 */

export interface LlmCompleteInput {
  system?: string;
  prompt: string;
  /** 0–1; higher = more varied narration. */
  temperature?: number;
}

export interface LlmClient {
  complete(input: LlmCompleteInput): Promise<string>;
}
