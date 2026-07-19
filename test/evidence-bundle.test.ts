import { describe, it, expect, beforeEach } from "vitest";
import { type EvidenceBundle, canonicalizeBundle, bundleHash } from "@/core/evidence-bundle";
import { createMockEvidenceStore, __resetEvidenceStore } from "@/adapters/mock/mock-evidence-store";

beforeEach(() => __resetEvidenceStore());

function bundle(over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    version: 1,
    marketId: "testnet:m",
    recipeHash: "sha256:recipe",
    winningOutcomeKey: "yes",
    resolvedAtIso: "2026-08-01T00:00:00.000Z",
    sources: [{ source: "coingecko", metric: "cspr_usd", reference: "close price" }],
    snapshot: { cspr_usd: "0.11" },
    reasoning: "price cleared the threshold",
    ...over,
  };
}

describe("evidence bundle hashing", () => {
  it("is stable across runs (content-addressed)", () => {
    expect(bundleHash(bundle())).toBe(bundleHash(bundle()));
    expect(bundleHash(bundle()).startsWith("sha256:")).toBe(true);
  });

  it("is independent of snapshot key insertion order", () => {
    const a = bundle({ snapshot: { a: "1", b: "2" } });
    const b = bundle({ snapshot: { b: "2", a: "1" } });
    expect(canonicalizeBundle(a)).toBe(canonicalizeBundle(b));
    expect(bundleHash(a)).toBe(bundleHash(b));
  });

  it("changes when any material field changes", () => {
    const base = bundleHash(bundle());
    expect(bundleHash(bundle({ winningOutcomeKey: "no" }))).not.toBe(base);
    expect(bundleHash(bundle({ snapshot: { cspr_usd: "0.12" } }))).not.toBe(base);
    expect(bundleHash(bundle({ reasoning: "different" }))).not.toBe(base);
    expect(bundleHash(bundle({ recipeHash: "sha256:other" }))).not.toBe(base);
  });
});

describe("mock evidence store — content-addressed CAS", () => {
  it("put returns a content hash + uri, get round-trips", async () => {
    const store = createMockEvidenceStore();
    const stored = await store.put(bundle());
    expect(stored.hash).toBe(bundleHash(bundle()));
    expect(stored.uri).toBe(`cas:${stored.hash}`);
    const back = await store.get(stored.hash);
    expect(back).toEqual(bundle());
  });

  it("is idempotent by content", async () => {
    const store = createMockEvidenceStore();
    const a = await store.put(bundle());
    const b = await store.put(bundle());
    expect(a.hash).toBe(b.hash);
  });

  it("returns null for an unknown hash", async () => {
    const store = createMockEvidenceStore();
    expect(await store.get("sha256:missing")).toBeNull();
  });
});
