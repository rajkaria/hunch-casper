/**
 * GET /api/deploy-plan/mainnet-preflight — the mainnet deploy dry run.
 *
 * Returns the full cost + address plan for putting the catalogue on mainnet and performs ZERO
 * transactions (`transactionsPerformed: false`, asserted in tests). It is read-only and
 * credential-free — the whole point is that an operator, or CI, can see the complete plan and the
 * audit gate before anyone spends a mote. `?format=text` returns the rendered plan for a terminal;
 * `?seed=false` excludes house-seed liquidity from the cost.
 *
 * Actually spending is a separate, deliberate command (`contracts/bin/cli.rs`, decision D2) — there
 * is deliberately no code path from this endpoint to a signed transaction.
 */

import { NextResponse } from "next/server";
import { buildMainnetPreflight, renderPreflight } from "@/core/mainnet-preflight";

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const seedHouseLiquidity = params.get("seed") !== "false";
  const plan = buildMainnetPreflight({ seedHouseLiquidity });

  if (params.get("format") === "text") {
    return new Response(renderPreflight(plan), {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.json(plan);
}
