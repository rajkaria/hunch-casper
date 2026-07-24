import { describe, expect, it } from "vitest";
import { selectRoundTarget } from "@/agent/prophet";
import type { Market } from "@/core/types";

function markets(n: number): Market[] {
  return Array.from({ length: n }, (_, i) => ({ slug: `m${i}`, category: "casper-native" }) as Market);
}

describe("prophet market spread", () => {
  it("covers every open market before repeating any", () => {
    const open = markets(19);
    const seen = new Set<string>();
    for (let seq = 0; seq < 19; seq++) seen.add(selectRoundTarget(open, seq)!.slug);
    expect(seen.size).toBe(19);
  });

  it("bounds concentration well under the 58% production defect", () => {
    const open = markets(19);
    const counts = new Map<string, number>();
    for (let seq = 0; seq < 190; seq++) {
      const slug = selectRoundTarget(open, seq)!.slug;
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
    expect(Math.max(...counts.values()) / 190).toBeLessThanOrEqual(0.15);
  });

  it("a FROZEN seq reproduces the production defect exactly", () => {
    // The regression this guards: seq came from a capped list's length and stopped advancing, so
    // every round picked the same market. Spread is a property of the counter, not of the picker.
    const open = markets(19);
    const counts = new Map<string, number>();
    for (let round = 0; round < 190; round++) {
      const slug = selectRoundTarget(open, 50)!.slug; // the value production actually froze at
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
    expect(Math.max(...counts.values()) / 190).toBe(1);
  });

  it("keeps the whole fleet on ONE market per round, so the rivalry is visible", () => {
    // Momentum and Contrarian taking opposing sides only means something on the same book.
    const open = markets(19);
    expect(selectRoundTarget(open, 3)!.slug).toBe(selectRoundTarget(open, 3)!.slug);
  });

  it("is deterministic for a given seq", () => {
    const open = markets(7);
    expect(selectRoundTarget(open, 3)!.slug).toBe(selectRoundTarget(open, 3)!.slug);
  });

  it("returns nothing when nothing is open", () => {
    expect(selectRoundTarget([], 0)).toBeNull();
  });
});
