/**
 * The evidence viewer's payload guard.
 *
 * The crash it pins: a round slug carries `#` (`cspr-hourly-updown#20658`); interpolated raw into
 * the fetch URL the browser truncated it at the fragment, the request hit `/api/markets/[slug]`
 * instead of `/evidence`, and that endpoint's `200 {market}` reached a render that dereferenced
 * `data.link.recipeHash` — a TypeError that crash-looped the whole round page. The fetch now
 * encodes the slug AND the payload is parsed before render; anything that is not an evidence
 * bundle settles to the no-evidence state.
 */

import { describe, it, expect } from "vitest";
import { parseEvidenceResponse } from "@/components/evidence-viewer";

const validPayload = {
  link: {
    recipeHash: "ab".repeat(32),
    bundleHash: "cd".repeat(32),
    uri: "kv://evidence/1",
    resolvedAtIso: "2026-07-20T00:00:00.000Z",
  },
  bundle: {
    winningOutcomeKey: "up",
    sources: [{ source: "coingecko", metric: "cspr_usd", reference: "close vs open" }],
    snapshot: { open: "0.041", close: "0.042" },
    reasoning: "Close above open.",
  },
  verification: { ok: true, recipeHashMatches: true, bundleHashMatches: true, outcomeMatches: true },
};

describe("parseEvidenceResponse", () => {
  it("accepts a real evidence payload verbatim", () => {
    expect(parseEvidenceResponse(validPayload)).toEqual(validPayload);
  });

  it("rejects the market-endpoint shape that used to crash-loop round pages", () => {
    // Exactly what the truncated URL fetched: `{ market: {...} }`, no `link`.
    expect(parseEvidenceResponse({ market: { slug: "cspr-hourly-updown", status: "open" } })).toBeNull();
  });

  it("rejects non-object junk instead of throwing on it", () => {
    for (const junk of [null, undefined, 42, "evidence", [], { link: null }, { link: {} }]) {
      expect(parseEvidenceResponse(junk)).toBeNull();
    }
  });

  it("normalises missing optional fields so the render never dereferences undefined", () => {
    const sparse = parseEvidenceResponse({
      link: { recipeHash: "aa", bundleHash: "bb" },
      bundle: {},
    });
    expect(sparse).not.toBeNull();
    expect(sparse!.bundle.sources).toEqual([]);
    expect(sparse!.bundle.snapshot).toEqual({});
    expect(sparse!.bundle.reasoning).toBe("");
    expect(sparse!.bundle.winningOutcomeKey).toBeNull();
    expect(sparse!.verification).toBeNull();
  });

  it("drops malformed source/snapshot entries rather than rendering them", () => {
    const parsed = parseEvidenceResponse({
      ...validPayload,
      bundle: {
        ...validPayload.bundle,
        sources: [{ source: "drand", metric: "round" }, { bogus: true }, null],
        snapshot: { good: "1", bad: 42 },
      },
    });
    expect(parsed!.bundle.sources).toEqual([{ source: "drand", metric: "round" }]);
    expect(parsed!.bundle.snapshot).toEqual({ good: "1" });
  });
});
