/**
 * The evidence bundle — the replayable record of *why* a market resolved the way it did.
 *
 * A bundle pins, in one canonical object: the market + the recipe hash it resolved under, the
 * winning outcome (or void), the sources consulted, the numeric **snapshot** those sources were
 * read at, and the Arbiter's reasoning. Its content hash (`sha256:` over the canonical form) is
 * committed on chain with the resolution, so a third party can fetch the bundle, recompute the
 * hash, and *replay the recipe against the snapshot* to independently confirm the winner.
 *
 * Canonicalisation mirrors `resolution-recipe.ts`: fixed key order, sorted snapshot keys, NFC —
 * so the same bundle always hashes identically across runs and machines (content-addressing only
 * works if the address is stable). The `reasoning` prose IS included in the hash here (unlike the
 * recipe): the bundle is a record, and altering the stated reasoning after the fact should change
 * the record's identity.
 */

import { sha256Hex } from "./sha256";

export const EVIDENCE_BUNDLE_VERSION = 1 as const;

export interface EvidenceSource {
  /** A short id for the source, e.g. "coingecko", "cspr_cloud". */
  source: string;
  /** The metric/endpoint read. */
  metric: string;
  /** A retrieval reference (URL/query) — recorded verbatim, not fetched here. */
  reference: string;
}

export interface EvidenceBundle {
  version: typeof EVIDENCE_BUNDLE_VERSION;
  marketId: string;
  /** The recipe hash this resolution ran under — ties the bundle to the committed rule. */
  recipeHash: string;
  /** Winning outcome key, or `null` for a void. */
  winningOutcomeKey: string | null;
  /** The instant the snapshot was taken (ISO UTC). */
  resolvedAtIso: string;
  /** The sources consulted. */
  sources: EvidenceSource[];
  /**
   * The numeric snapshot the recipe was replayed against — `metricKey -> value` (string for
   * precision). For a threshold market this holds the read metric; for an internal/meta market it
   * holds the board figures. Replaying the recipe against exactly this snapshot must reproduce
   * `winningOutcomeKey`.
   */
  snapshot: Record<string, string>;
  /** The Arbiter's advisory reasoning (part of the record; hashed). */
  reasoning: string;
}

/** Canonical string form — fixed key order, sorted snapshot keys, NFC. The bytes that get hashed. */
export function canonicalizeBundle(bundle: EvidenceBundle): string {
  const nfc = (s: string): string => s.normalize("NFC");
  const sources = bundle.sources.map((s) => ({
    source: nfc(s.source),
    metric: nfc(s.metric),
    reference: nfc(s.reference),
  }));
  const snapshotKeys = Object.keys(bundle.snapshot).sort();
  const snapshot = snapshotKeys.map((k) => [nfc(k), nfc(bundle.snapshot[k])] as const);

  const ordered: Array<[string, unknown]> = [
    ["version", bundle.version],
    ["marketId", nfc(bundle.marketId)],
    ["recipeHash", bundle.recipeHash],
    ["winningOutcomeKey", bundle.winningOutcomeKey],
    ["resolvedAtIso", bundle.resolvedAtIso],
    ["sources", sources],
    ["snapshot", snapshot],
    ["reasoning", nfc(bundle.reasoning)],
  ];
  const body = ordered.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",");
  return `{${body}}`;
}

/** The content hash of a bundle — `sha256:`-prefixed, stable across runs. */
export function bundleHash(bundle: EvidenceBundle): string {
  return `sha256:${sha256Hex(canonicalizeBundle(bundle))}`;
}
