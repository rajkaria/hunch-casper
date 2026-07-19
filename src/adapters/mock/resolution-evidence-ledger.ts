/**
 * A tiny market → evidence linkage ledger. The evidence store is content-addressed (keyed by
 * bundle hash), so to render "the evidence for THIS market" we need the market→hash pointer the
 * Arbiter records at resolution. This is that pointer: `marketId -> {recipeHash, bundleHash, uri}`,
 * written by the Arbiter and read by the evidence route/viewer, which then fetches the bundle body
 * from the store by hash. In-process demo state (like the other mock ledgers).
 */

export interface ResolutionEvidenceLink {
  marketId: string;
  recipeHash: string;
  bundleHash: string;
  uri: string;
  resolvedAtIso: string;
}

const ledger = new Map<string, ResolutionEvidenceLink>();

export function recordResolutionEvidence(link: ResolutionEvidenceLink): void {
  ledger.set(link.marketId, link);
}

export function resolutionEvidenceFor(marketId: string): ResolutionEvidenceLink | null {
  return ledger.get(marketId) ?? null;
}

/** Test-only: forget every recorded linkage. */
export function __resetResolutionEvidence(): void {
  ledger.clear();
}
