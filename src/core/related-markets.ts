/**
 * Pure related-markets ranking. Given a market and the full catalogue, surface its closest
 * siblings — same category and/or shared subject (title keywords) — ranked deterministically.
 * No network calls, no adapters: a pure function over `Market`s, testable in isolation and
 * identical on server and client. Mirrors the "same-token + same-type siblings" rule from the
 * live Hunch product's related-markets section.
 */

import type { Market } from "@/core/types";

const STOPWORDS = new Set([
  "the", "a", "an", "by", "or", "and", "of", "to", "is", "in", "on", "at", "for",
  "above", "below", "this", "week", "hour", "aug", "count",
]);

/** Significant lowercase tokens from a market's title — the subject fingerprint. */
function subjectTokens(market: Market): Set<string> {
  const tokens = market.title
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function sharedTokenCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

/**
 * Rank the closest siblings of `market` within `all` (same network only). Score = same-category
 * (weighted) + shared subject tokens; ties broken by higher total staked, then slug for
 * determinism. Excludes the market itself and any zero-score outsider. Returns up to `limit`.
 */
export function relatedMarkets(market: Market, all: Market[], limit = 4): Market[] {
  const selfTokens = subjectTokens(market);
  return all
    .filter((m) => m.slug !== market.slug && m.network === market.network)
    .map((m) => {
      const sameCategory = m.category === market.category ? 2 : 0;
      const shared = sharedTokenCount(selfTokens, subjectTokens(m));
      return { m, score: sameCategory + shared };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      const dx = BigInt(x.m.totalStakedMotes);
      const dy = BigInt(y.m.totalStakedMotes);
      if (dx !== dy) return dy > dx ? 1 : -1;
      return x.m.slug.localeCompare(y.m.slug);
    })
    .slice(0, limit)
    .map((x) => x.m);
}
