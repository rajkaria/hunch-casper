/**
 * The pinned market. Two of these rules are the reason this is a tested function and not JSX: a
 * settled market must never keep headlining the board, and the headline must not also appear as a
 * card underneath it (a visitor counting the board would count it twice).
 */

import { describe, it, expect } from "vitest";
import { buildCatalogue } from "@/core/catalogue";
import { BUILDATHON_MARKET_SLUG } from "@/core/buildathon-field";
import {
  FEATURED_MARKET_SLUGS,
  featuredFirst,
  isFeaturedSlug,
  partitionFeatured,
} from "@/core/featured";
import type { Market, MarketStatus } from "@/core/types";

const board = buildCatalogue("testnet");
const pinned = board.find((m) => m.slug === BUILDATHON_MARKET_SLUG)!;
const other = board.find((m) => m.slug !== BUILDATHON_MARKET_SLUG)!;

/** The catalogue's own statuses drift with the clock; these tests pin them explicitly. */
const withStatus = (m: Market, status: MarketStatus): Market => ({ ...m, status });
const openBoard = (): Market[] => [withStatus(other, "open"), withStatus(pinned, "open")];

describe("which slugs can be pinned", () => {
  it("pins the buildathon field market", () => {
    expect(FEATURED_MARKET_SLUGS).toContain(BUILDATHON_MARKET_SLUG);
    expect(isFeaturedSlug(BUILDATHON_MARKET_SLUG)).toBe(true);
  });

  it("pins nothing else", () => {
    expect(isFeaturedSlug(other.slug)).toBe(false);
    expect(isFeaturedSlug("not-a-market")).toBe(false);
  });
});

describe("partitionFeatured", () => {
  it("lifts the pinned market out of the grid — it renders once, as the headline", () => {
    const { featured, rest } = partitionFeatured(openBoard());
    expect(featured?.slug).toBe(BUILDATHON_MARKET_SLUG);
    expect(rest.map((m) => m.slug)).not.toContain(BUILDATHON_MARKET_SLUG);
    expect(rest).toHaveLength(1);
  });

  /** A resolved question at the top of the board reads as the thing to bet on. It is not. */
  it("stops headlining once the market is no longer open", () => {
    for (const status of ["locked", "resolved", "void"] as const) {
      const { featured, rest } = partitionFeatured([withStatus(pinned, status), withStatus(other, "open")]);
      expect(featured).toBeNull();
      // …and it stays in the grid, where its status chip says what happened.
      expect(rest.map((m) => m.slug)).toContain(BUILDATHON_MARKET_SLUG);
    }
  });

  it("headlines a category the pin belongs to", () => {
    const { featured, rest } = partitionFeatured(openBoard(), "community");
    expect(featured?.slug).toBe(BUILDATHON_MARKET_SLUG);
    expect(rest.map((m) => m.slug)).not.toContain(BUILDATHON_MARKET_SLUG);
  });

  it("headlines nothing under a category the pin is not in", () => {
    const { featured, rest } = partitionFeatured(openBoard(), "rwa");
    expect(featured).toBeNull();
    // `rest` is the caller's list untouched — the page has already filtered it.
    expect(rest).toHaveLength(2);
  });

  it("returns the board unchanged when the pin is absent (e.g. the mainnet catalogue)", () => {
    const noPin = [withStatus(other, "open")];
    const { featured, rest } = partitionFeatured(noPin);
    expect(featured).toBeNull();
    expect(rest).toEqual(noPin);
  });

  it("never mutates the caller's array", () => {
    const input = openBoard();
    const snapshot = input.map((m) => m.slug);
    partitionFeatured(input);
    expect(input.map((m) => m.slug)).toEqual(snapshot);
  });

  it("is empty-safe", () => {
    expect(partitionFeatured([])).toEqual({ featured: null, rest: [] });
  });
});

describe("featuredFirst", () => {
  it("moves an open pin to the front and keeps everything else in order", () => {
    const rest = board.filter((m) => m.slug !== BUILDATHON_MARKET_SLUG).slice(0, 3).map((m) => withStatus(m, "open"));
    const ordered = featuredFirst([...rest, withStatus(pinned, "open")]);
    expect(ordered[0]?.slug).toBe(BUILDATHON_MARKET_SLUG);
    expect(ordered.slice(1).map((m) => m.slug)).toEqual(rest.map((m) => m.slug));
    expect(ordered).toHaveLength(rest.length + 1);
  });

  it("drops nothing and promotes nothing when the pin has settled", () => {
    const input = [withStatus(other, "open"), withStatus(pinned, "resolved")];
    expect(featuredFirst(input).map((m) => m.slug)).toEqual(input.map((m) => m.slug));
  });
});
