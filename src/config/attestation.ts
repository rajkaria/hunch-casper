/**
 * Attested resolutions — the operator-supplied result for a market no feed publishes.
 *
 * Every other market on the board settles from a datum an adapter can fetch: a price, a chain
 * read, a randomness beacon, the economy's own boards. A market on "which project wins this
 * hackathon" has no such datum — the answer exists only in an announcement a human reads. The
 * honest options are an attestation anyone can check, or no market at all.
 *
 * So the winner arrives here, as explicit operator configuration, and NOT from the OraclePort:
 * the mock oracle picks a deterministic pseudo-random outcome for any market it is asked about,
 * which is exactly right for a threshold market in a demo and catastrophic for this one — it
 * would declare a winner of a real contest by hashing a market id. The Arbiter therefore refuses
 * to resolve an attested market until this attestation exists, and until then the market simply
 * sits locked, which is the correct state for "the result is not out yet".
 *
 * Format — `MARKET_ATTESTATIONS`, a JSON object keyed by catalogue slug:
 *
 * ```json
 * {
 *   "casper-buildathon-2026-winner": {
 *     "winningOutcomeKey": "46696",
 *     "evidenceUrl": "https://dorahacks.io/hackathon/casper-agentic/results",
 *     "evidenceHash": "<sha256 of the fetched announcement>",
 *     "note": "Grand prize announced 2026-09-02"
 *   }
 * }
 * ```
 *
 * `winningOutcomeKey: null` voids the market instead — the escape hatch for an announcement that
 * names co-winners with no single first place. Every stake refunds in full.
 */

export interface MarketAttestation {
  /** The winning outcome key, or `null` to void and refund. */
  winningOutcomeKey: string | null;
  /** Where the result was published — carried into the resolution rationale and the evidence bundle. */
  evidenceUrl?: string;
  /** Content hash of the published announcement, committed on chain beside the resolution. */
  evidenceHash?: string;
  /** Optional operator note, shown in the rationale. */
  note?: string;
}

function parse(raw: string | undefined): Record<string, MarketAttestation> {
  if (!raw || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed attestation must not resolve anything. Empty means "no result yet", which
    // leaves markets locked — the safe direction for a parse failure to fail in.
    console.warn("[attestation] MARKET_ATTESTATIONS is not valid JSON — ignoring it");
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, MarketAttestation> = {};
  for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const key = v.winningOutcomeKey;
    if (key !== null && typeof key !== "string") continue;
    if (typeof key === "string" && key.trim().length === 0) continue;
    out[slug] = {
      winningOutcomeKey: key,
      evidenceUrl: typeof v.evidenceUrl === "string" ? v.evidenceUrl : undefined,
      evidenceHash: typeof v.evidenceHash === "string" ? v.evidenceHash : undefined,
      note: typeof v.note === "string" ? v.note : undefined,
    };
  }
  return out;
}

/** The operator's attestation for a market slug, or `undefined` while no result is published. */
export function attestationFor(slug: string): MarketAttestation | undefined {
  return parse(process.env.MARKET_ATTESTATIONS)[slug];
}
