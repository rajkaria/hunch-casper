/**
 * Agent market-maker strategy (S28) — the Prophets graduate from takers to makers. Given an LMSR
 * book and the maker's belief about the true probabilities, this produces the trades that quote a
 * two-sided spread and nudge the book toward that belief, always within the risk controls.
 *
 * Pure and deterministic (belief + book in, trades out), so a maker's behaviour is testable without
 * a chain. The maker earns by quoting a spread around the mid-price: it buys the outcome it thinks
 * is under-priced and lays off the over-priced one, capturing the gap between the book's price and
 * its belief — bounded by the circuit breaker so no single quote yanks the book.
 */

import { lmsrPrices, type LmsrState } from "./lmsr";
import { vetTrade, type LmsrRiskConfig, DEFAULT_LMSR_RISK } from "./lmsr-risk";

export interface MmQuote {
  /** Outcome index to trade. */
  outcome: number;
  /** Signed share delta: >0 buy (price too low vs belief), <0 sell (too high). */
  delta: number;
  /** The book price before the trade. */
  bookPrice: number;
  /** The maker's believed probability for this outcome. */
  belief: number;
}

export interface MmConfig {
  /** Only quote when |belief − price| exceeds this edge (avoid churning on noise). */
  minEdge: number;
  /** Base trade size (shares) per unit of edge — scales the nudge with conviction. */
  sizePerEdge: number;
  risk: LmsrRiskConfig;
}

export const DEFAULT_MM_CONFIG: MmConfig = { minEdge: 0.03, sizePerEdge: 200, risk: DEFAULT_LMSR_RISK };

/**
 * Produce the maker's quotes for a book given its belief distribution. For each outcome whose book
 * price differs from belief by more than `minEdge`, it proposes a trade toward belief, sized by the
 * edge and clamped so the risk breaker passes (a rejected size is halved until it fits, down to a
 * floor). Returns only the trades that clear the risk vet.
 */
export function makerQuotes(
  state: LmsrState,
  belief: number[],
  config: MmConfig = DEFAULT_MM_CONFIG,
): MmQuote[] {
  if (belief.length !== state.q.length) throw new Error("mm: belief length must match outcomes");
  const prices = lmsrPrices(state);
  const quotes: MmQuote[] = [];

  for (let i = 0; i < prices.length; i++) {
    const edge = belief[i] - prices[i];
    if (Math.abs(edge) < config.minEdge) continue;
    // Direction: buy if under-priced (belief > price), sell if over-priced.
    let size = Math.round(Math.abs(edge) * config.sizePerEdge) * Math.sign(edge);
    if (size === 0) continue;
    // Clamp to the circuit breaker: halve until the trade vets (or we hit the floor).
    let vet = vetTrade(state, i, size, config.risk);
    let guard = 0;
    while (!vet.ok && vet.reason === "circuit-breaker" && Math.abs(size) > 1 && guard < 32) {
      size = Math.trunc(size / 2);
      vet = vetTrade(state, i, size, config.risk);
      guard += 1;
    }
    if (vet.ok && size !== 0) {
      quotes.push({ outcome: i, delta: size, bookPrice: prices[i], belief: belief[i] });
    }
  }
  return quotes;
}

/**
 * Score a maker's realised performance for the registry's MM track record: the spread it captured,
 * i.e. Σ over its fills of `|belief − bookPrice| · |size|`. A maker that consistently trades real
 * edge scores high; one that churns noise scores ~0. Pure, so the registry can recompute it.
 */
export function makerEdgeCaptured(quotes: MmQuote[]): number {
  return quotes.reduce((sum, q) => sum + Math.abs(q.belief - q.bookPrice) * Math.abs(q.delta), 0);
}
