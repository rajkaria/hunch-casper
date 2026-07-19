import { describe, it, expect } from "vitest";
import {
  calibrationCurve,
  calibrationCurveToCsv,
  oddsHistoryToCsv,
  crowdCalibrationSamples,
  type SettledMarketShape,
} from "@/core/calibration-curve";
import type { CalibrationSample } from "@/core/calibration";

function s(forecast: number, won: boolean, stake = "1000000000"): CalibrationSample {
  return { forecast, won, stakeMotes: stake };
}

describe("calibrationCurve — verified against hand-computed vectors", () => {
  it("bins forecasts and computes observed rate + ECE by hand", () => {
    // Two forecasts at 0.1 (0 wins), two at 0.9 (2 wins). 10 bins.
    const samples = [s(0.1, false), s(0.1, false), s(0.9, true), s(0.9, true)];
    const curve = calibrationCurve(samples, 10);
    expect(curve.sampleCount).toBe(4);

    const bin1 = curve.bins[1]; // [0.1, 0.2)
    expect(bin1.count).toBe(2);
    expect(bin1.meanForecast).toBeCloseTo(0.1, 10);
    expect(bin1.observedRate).toBe(0); // neither won

    const bin9 = curve.bins[9]; // [0.9, 1.0]
    expect(bin9.count).toBe(2);
    expect(bin9.meanForecast).toBeCloseTo(0.9, 10);
    expect(bin9.observedRate).toBe(1); // both won

    // ECE = weighted mean |meanForecast - observedRate| = (2*0.1 + 2*0.1)/4 = 0.1
    expect(curve.expectedCalibrationError).toBeCloseTo(0.1, 10);
  });

  it("a perfectly-calibrated set has ECE 0", () => {
    // Forecast 0.5 with exactly half winning.
    const curve = calibrationCurve([s(0.5, true), s(0.5, false)], 10);
    const bin5 = curve.bins[5]; // [0.5, 0.6)
    expect(bin5.meanForecast).toBeCloseTo(0.5, 10);
    expect(bin5.observedRate).toBe(0.5);
    expect(curve.expectedCalibrationError).toBeCloseTo(0, 10);
  });

  it("folds a forecast of exactly 1.0 into the last bin, clamps out-of-range", () => {
    const curve = calibrationCurve([s(1.0, true), s(1.5, true), s(-0.2, false)], 10);
    expect(curve.bins[9].count).toBe(2); // 1.0 and clamped 1.5
    expect(curve.bins[0].count).toBe(1); // clamped -0.2
  });

  it("empty input yields empty bins and zero ECE", () => {
    const curve = calibrationCurve([], 10);
    expect(curve.sampleCount).toBe(0);
    expect(curve.expectedCalibrationError).toBe(0);
    expect(curve.bins).toHaveLength(10);
  });
});

describe("exports are deterministic + byte-stable", () => {
  const samples = [s(0.2, false), s(0.8, true), s(0.8, false)];
  it("calibration CSV is stable across runs", () => {
    const a = calibrationCurveToCsv(calibrationCurve(samples, 5));
    const b = calibrationCurveToCsv(calibrationCurve(samples, 5));
    expect(a).toBe(b);
    expect(a.split("\n")[0]).toBe("lower,upper,count,meanForecast,observedRate");
  });

  it("odds-history CSV escapes and formats deterministically", () => {
    const csv = oddsHistoryToCsv([
      { atIso: "2026-08-01T00:00:00.000Z", marketId: "testnet:m", outcomeKey: "yes", probability: 0.66666 },
    ]);
    expect(csv.split("\n")[0]).toBe("atIso,marketId,outcomeKey,probability");
    expect(csv).toContain("0.6667"); // 4-dp deterministic rounding
  });
});

describe("crowdCalibrationSamples from settled markets", () => {
  const entries: SettledMarketShape[] = [
    {
      manifest: { winningOutcomeKey: "yes", totalPoolMotes: "1000" },
      stakesByBettor: { a: { yes: "700" }, b: { no: "300" } },
    },
    {
      manifest: { winningOutcomeKey: null, totalPoolMotes: "500" }, // void → skipped
      stakesByBettor: { a: { yes: "250" }, b: { no: "250" } },
    },
  ];

  it("produces one sample per outcome of each resolved market, skipping voids", () => {
    const samples = crowdCalibrationSamples(entries);
    // Market 1: yes (0.7, won) + no (0.3, lost). Void market skipped.
    expect(samples).toHaveLength(2);
    const yes = samples.find((x) => x.forecast === 0.7)!;
    expect(yes.won).toBe(true);
    const no = samples.find((x) => x.forecast === 0.3)!;
    expect(no.won).toBe(false);
  });
});
