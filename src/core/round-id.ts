/**
 * Round-addressable market ids — `<slug>#<roundIndex>`.
 *
 * A recurring market is not one market with a moving deadline; it is a series of markets, each
 * with its own pools, its own bettors and its own settlement. Collapsing them onto one id would
 * mix round N's stakes into round N+1's payout, which the parimutuel math has no way to unpick.
 * The slug stays the stable catalogue and UI identity; the suffix addresses one round of it.
 *
 * `#` is deliberate: catalogue slugs are kebab-case and never contain it, so `baseSlug` is
 * unambiguous and a legacy round-less id parses as itself.
 */

const SEP = "#";

/** Address one round of a recurring market. */
export function roundMarketId(slug: string, roundIndex: number): string {
  if (!Number.isInteger(roundIndex) || roundIndex < 0) {
    throw new Error(`round index must be a non-negative integer, got ${roundIndex}`);
  }
  return `${slug}${SEP}${roundIndex}`;
}

/** Split a market id into its slug and round. `roundIndex` is `null` for a non-recurring id. */
export function parseRoundMarketId(id: string): { slug: string; roundIndex: number | null } {
  const idx = id.lastIndexOf(SEP);
  if (idx < 0) return { slug: id, roundIndex: null };
  const suffix = id.slice(idx + SEP.length);
  // A suffix that is not a plain non-negative integer is part of the name, not a round.
  if (!/^\d+$/.test(suffix)) return { slug: id, roundIndex: null };
  return { slug: id.slice(0, idx), roundIndex: Number(suffix) };
}

/** The catalogue slug behind any market id, round-addressed or not. */
export function baseSlug(id: string): string {
  return parseRoundMarketId(id).slug;
}
