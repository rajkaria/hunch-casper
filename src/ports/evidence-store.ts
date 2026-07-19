/**
 * EvidenceStorePort — a content-addressed store for resolution evidence bundles.
 *
 * When the Arbiter resolves a market it publishes a bundle (the sources it read, the snapshot it
 * read them at, and its reasoning) to this store, which returns a content hash. That hash is what
 * gets committed on chain with the resolution (S24 `commit_bundle`), so "audit this resolution" is:
 * fetch the bundle by its hash, recompute the hash to confirm it wasn't altered, and replay the
 * recipe against the snapshot to confirm the winner. Content-addressing is the whole point — the
 * hash IS the integrity check, so a store that returns a tampered bundle is caught for free.
 *
 * Implementations: `adapters/mock/mock-evidence-store.ts` (a deterministic in-memory CAS for
 * CI/demo) and, behind the same interface, a pinning adapter (IPFS/Arweave) gated on credentials.
 */

import type { EvidenceBundle } from "@/core/evidence-bundle";

export interface StoredEvidence {
  /** The content hash (`sha256:…`) — the id AND the integrity check. */
  hash: string;
  /** A retrieval URI for the bundle (`cas:<hash>` for the mock; a gateway URL for a real pin). */
  uri: string;
}

export interface EvidenceStorePort {
  /**
   * Store a bundle, returning its content hash + URI. Idempotent by content: storing the same
   * bundle twice yields the same hash and does not duplicate.
   */
  put(bundle: EvidenceBundle): Promise<StoredEvidence>;
  /** Fetch a bundle by its content hash, or `null` if the store has never seen it. */
  get(hash: string): Promise<EvidenceBundle | null>;
}
