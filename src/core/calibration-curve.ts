/**
 * Calibration curves + feed exports (S27) — turning the economy's forecasts into an auditable,
 * sellable data product. Pure and deterministic: the same samples always produce the same curve and
 * the same CSV byte-for-byte, so an exported feed is reproducible and a buyer can verify it.
 *
 * A **calibration curve** (reliability diagram) bins forecasts by their predicted probability and,
 * per bin, reports the observed hit rate. A well-calibrated forecaster's "70%" predictions come
 * true ~70% of the time — the bin's `meanForecast` ≈ its `observedRate`. This is the number that
 * makes a probability feed trustworthy: not "we said 70%", but "when we say 70%, it happens 70% of
 * the time," shown, not claimed.
 */

import type { CalibrationSample } from "./calibration";

export interface CalibrationBin {
  /** Lower edge of the bin, inclusive, in [0, 1]. */
  lower: number;
  /** Upper edge of the bin, exclusive (except the last bin, which includes 1.0). */
  upper: number;
  /** Forecasts that fell in this bin. */
  count: number;
  /** Mean predicted probability of the forecasts in this bin. */
  meanForecast: number;
  /** Fraction of those forecasts that actually came true — the observed rate. */
  observedRate: number;
}

export interface CalibrationCurve {
  bins: CalibrationBin[];
  /** Total forecasts across all bins. */
  sampleCount: number;
  /**
   * Expected Calibration Error: the sample-weighted mean gap between predicted and observed across
   * bins. 0 is perfect calibration. This is the single scalar a buyer reads to trust the feed.
   */
  expectedCalibrationError: number;
}

/**
 * Build a reliability curve over `binCount` equal-width bins on [0, 1]. A forecast of exactly 1.0
 * lands in the last bin. Empty bins are reported (count 0) so the curve has a stable shape.
 */
export function calibrationCurve(samples: readonly CalibrationSample[], binCount = 10): CalibrationCurve {
  const bins: { count: number; forecastSum: number; hits: number }[] = Array.from(
    { length: binCount },
    () => ({ count: 0, forecastSum: 0, hits: 0 }),
  );

  for (const s of samples) {
    const f = clamp01(s.forecast);
    // Index: floor(f * binCount), with f === 1 folded into the last bin.
    const idx = f >= 1 ? binCount - 1 : Math.floor(f * binCount);
    bins[idx].count += 1;
    bins[idx].forecastSum += f;
    if (s.won) bins[idx].hits += 1;
  }

  let weightedGap = 0;
  let total = 0;
  const out: CalibrationBin[] = bins.map((b, i) => {
    const meanForecast = b.count > 0 ? b.forecastSum / b.count : 0;
    const observedRate = b.count > 0 ? b.hits / b.count : 0;
    if (b.count > 0) {
      weightedGap += b.count * Math.abs(meanForecast - observedRate);
      total += b.count;
    }
    return {
      lower: i / binCount,
      upper: (i + 1) / binCount,
      count: b.count,
      meanForecast,
      observedRate,
    };
  });

  return {
    bins: out,
    sampleCount: total,
    expectedCalibrationError: total > 0 ? weightedGap / total : 0,
  };
}

function clamp01(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1, Math.max(0, p));
}

// ── Exports (deterministic CSV/JSON for the feed product) ─────────────────────────────────────────

export interface OddsHistoryPoint {
  /** ISO timestamp of the observation. */
  atIso: string;
  marketId: string;
  outcomeKey: string;
  /** Implied probability in [0, 1]. */
  probability: number;
}

/** RFC-4180-ish CSV of an odds history — stable column order, deterministic row order preserved. */
export function oddsHistoryToCsv(points: readonly OddsHistoryPoint[]): string {
  const header = "atIso,marketId,outcomeKey,probability";
  const rows = points.map(
    (p) => `${csvField(p.atIso)},${csvField(p.marketId)},${csvField(p.outcomeKey)},${round4(p.probability)}`,
  );
  return [header, ...rows].join("\n");
}

/** CSV of a calibration curve — one row per bin. */
export function calibrationCurveToCsv(curve: CalibrationCurve): string {
  const header = "lower,upper,count,meanForecast,observedRate";
  const rows = curve.bins.map(
    (b) => `${round4(b.lower)},${round4(b.upper)},${b.count},${round4(b.meanForecast)},${round4(b.observedRate)}`,
  );
  return [header, ...rows].join("\n");
}

// ── Crowd calibration from settled markets ────────────────────────────────────────────────────────

/** The minimal shape of a settled market this module needs — a subset of the store's SettledEntry. */
export interface SettledMarketShape {
  stakesByBettor: Record<string, Record<string, string>>;
  manifest: { winningOutcomeKey: string | null; totalPoolMotes: string };
}

/**
 * Turn settled markets into calibration samples for the CROWD's final odds: for each resolved
 * market and each outcome, the sample is `(forecast = final pool-implied probability, won = it was
 * the winner)`, weighted by the outcome's pool. The resulting curve answers "when the pools imply
 * 70%, does it happen 70% of the time?" — the public-good calibration of the market itself. Void
 * markets are skipped (no ground truth).
 */
export function crowdCalibrationSamples(entries: readonly SettledMarketShape[]): CalibrationSample[] {
  const samples: CalibrationSample[] = [];
  for (const entry of entries) {
    const winner = entry.manifest.winningOutcomeKey;
    if (winner === null) continue;
    const total = BigInt(entry.manifest.totalPoolMotes);
    if (total <= 0n) continue;
    // Reconstruct per-outcome pools from the bettor stakes.
    const poolByOutcome: Record<string, bigint> = {};
    for (const byOutcome of Object.values(entry.stakesByBettor)) {
      for (const [outcome, motes] of Object.entries(byOutcome)) {
        poolByOutcome[outcome] = (poolByOutcome[outcome] ?? 0n) + BigInt(motes);
      }
    }
    for (const [outcome, pool] of Object.entries(poolByOutcome)) {
      samples.push({
        forecast: Number(pool) / Number(total),
        won: outcome === winner,
        stakeMotes: pool.toString(),
      });
    }
  }
  return samples;
}

function round4(n: number): string {
  // Deterministic 4-dp formatting; trims to a stable string so exports are byte-reproducible.
  return (Math.round(n * 10000) / 10000).toString();
}

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
