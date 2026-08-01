/**
 * The pinned market — what the board leads with.
 *
 * One market at a time is promoted out of the grid and into a headline card at the top of
 * `/markets`. The rules are here rather than in the page because two of them are easy to get
 * wrong in JSX and expensive to get wrong in public: a pinned market that has already resolved
 * must not keep headlining the board (the top of the page would advertise a settled question as
 * the thing to bet on), and the headline copy must not also appear as a card below it, because a
 * visitor counting markets would count it twice.
 */

// Relative (not `@/`) so the emitted `.d.ts` resolves inside the published SDK package.
import type { Market, MarketCategory } from "./types";
import { BUILDATHON_MARKET_SLUG } from "./buildathon-field";

/**
 * Slugs eligible to headline the board, best first. A list rather than a flag on the market so
 * the read model stays what the chain and the catalogue say — being featured is an editorial
 * decision about one deployment's front page, not a property of the market.
 */
export const FEATURED_MARKET_SLUGS: readonly string[] = [BUILDATHON_MARKET_SLUG];

/** Is this slug eligible to be pinned? (Eligible ≠ shown — see `partitionFeatured`.) */
export function isFeaturedSlug(slug: string): boolean {
  return FEATURED_MARKET_SLUGS.includes(slug);
}

export interface FeaturedSplit {
  /** The market to headline, or `null` when nothing on this board qualifies. */
  featured: Market | null;
  /** Everything else, in input order — the grid below the headline. */
  rest: Market[];
}

/**
 * Split a board into its headline and the rest.
 *
 * `filter` is the category the visitor is looking at (`"all"` for the whole board). A pinned
 * market only headlines a category it actually belongs to; under any other filter it is simply
 * absent, exactly like every other market outside that category.
 *
 * Only an `open` market headlines. A locked or resolved market stays in the grid with its status
 * chip, where the copy around it is honest about it being over.
 */
export function partitionFeatured(
  markets: readonly Market[],
  filter: MarketCategory | "all" = "all",
): FeaturedSplit {
  const eligible = markets.filter(
    (m) => isFeaturedSlug(m.slug) && m.status === "open" && (filter === "all" || m.category === filter),
  );
  // Ties break on `FEATURED_MARKET_SLUGS` order, so the pin is deterministic when a future
  // deployment pins more than one.
  eligible.sort(
    (a, b) => FEATURED_MARKET_SLUGS.indexOf(a.slug) - FEATURED_MARKET_SLUGS.indexOf(b.slug),
  );
  const featured = eligible[0] ?? null;
  return {
    featured,
    rest: featured ? markets.filter((m) => m.id !== featured.id) : [...markets],
  };
}

/**
 * The board reordered so a pinned market leads — for surfaces that have one flat list and no
 * headline slot of their own (the odds tape). Unlike `partitionFeatured` this drops nothing: a
 * pinned market that is locked or resolved simply keeps its natural place.
 */
export function featuredFirst(markets: readonly Market[]): Market[] {
  const pinned = markets.filter((m) => isFeaturedSlug(m.slug) && m.status === "open");
  if (pinned.length === 0) return [...markets];
  const pinnedIds = new Set(pinned.map((m) => m.id));
  return [...pinned, ...markets.filter((m) => !pinnedIds.has(m.id))];
}
