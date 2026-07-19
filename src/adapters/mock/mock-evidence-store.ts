/**
 * Deterministic in-memory content-addressed store for evidence bundles — the CI/demo
 * `EvidenceStorePort`. Keyed by the bundle's content hash, so `put` is idempotent by content and
 * `get` returns exactly what was stored. The real adapter (IPFS/Arweave pinning) satisfies the
 * same interface; nothing above the port knows the difference.
 *
 * State is a module singleton (like the other mock ledgers) so a bundle published on one request
 * is retrievable on the next within an instance; it resets between tests via `__resetEvidenceStore`.
 */

import type { EvidenceStorePort, StoredEvidence } from "@/ports/evidence-store";
import type { EvidenceBundle } from "@/core/evidence-bundle";
import { bundleHash } from "@/core/evidence-bundle";

const store = new Map<string, EvidenceBundle>();

export function createMockEvidenceStore(): EvidenceStorePort {
  return {
    async put(bundle: EvidenceBundle): Promise<StoredEvidence> {
      const hash = bundleHash(bundle);
      // Idempotent by content — re-storing the same bundle is a no-op that returns the same hash.
      if (!store.has(hash)) store.set(hash, bundle);
      return { hash, uri: `cas:${hash}` };
    },
    async get(hash: string): Promise<EvidenceBundle | null> {
      return store.get(hash) ?? null;
    },
  };
}

/** Test-only: forget every stored bundle. */
export function __resetEvidenceStore(): void {
  store.clear();
}
