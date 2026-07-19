/**
 * GET /api/odds/history — the calibration export (S27). The odds feed's audit trail: how well did
 * the crowd's final odds actually predict outcomes?
 *
 * Computes a reliability curve over every settled market's final pool-implied odds (pure
 * `core/calibration-curve.ts`) plus the Brier/skill score (`core/calibration.ts`). `?format=csv`
 * returns the curve as CSV; default is JSON. Deterministic — the same settled history always
 * exports identical bytes, so a buyer can reproduce and verify it. Free to read (a public-good
 * calibration record); the live number is what's metered (`/api/odds`).
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";
import { calibrationCurve, calibrationCurveToCsv, crowdCalibrationSamples } from "@/core/calibration-curve";
import { calibrationScore } from "@/core/calibration";

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const netParam = params.get("network");
  const network = isCasperNetwork(netParam) ? netParam : DEFAULT_NETWORK;
  const binCount = Math.min(Math.max(Number(params.get("bins")) || 10, 2), 20);

  const container = createContainer(network);
  const entries = await container.store.settledEntries(network);
  const samples = crowdCalibrationSamples(entries);
  const curve = calibrationCurve(samples, binCount);

  if (params.get("format") === "csv") {
    return new Response(calibrationCurveToCsv(curve), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="hunch-calibration-${network}.csv"`,
        "cache-control": "public, max-age=60, s-maxage=300",
      },
    });
  }

  const score = calibrationScore(samples);
  return NextResponse.json(
    {
      network,
      settledMarkets: entries.length,
      score: { brier: score.brier, skillBps: score.skillBps, hitRate: score.hitRate, sampleCount: score.sampleCount },
      calibration: curve,
    },
    { status: 200, headers: { "cache-control": "public, max-age=60, s-maxage=300" } },
  );
}
