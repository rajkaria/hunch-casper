/**
 * POST /api/agent/genesis/run — fire the Genesis market-maker once.
 *
 * This is the autonomous entry point: a Vercel cron hits it on a schedule and a fresh market
 * appears, created from a live CSPR.cloud-style signal. The demo can also fire it by hand. In
 * real mode it is gated by `GENESIS_CRON_SECRET` (x-cron-secret header); in the credential-free
 * mock/demo it is open. Genesis is privileged (only the market maker opens markets), so the gate
 * matters once it touches a real MarketFactory.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { runGenesis } from "@/agent/genesis";
import type { GenesisTrigger } from "@/agent/genesis";
import { listCreatedMarkets } from "@/adapters/mock/market-source";
import { isCasperNetwork } from "@/config/network";
import { chainMode } from "@/config/chain-mode";

/** A tiny rotating mock CSPR.cloud feed — real Genesis reads live CSPR.cloud endpoints here. */
const SIGNALS: { metric: string; value: string; unitLabel: string }[] = [
  { metric: "cspr_usd", value: "0.05", unitLabel: "$" },
  { metric: "daily_deploys", value: "28000", unitLabel: "" },
  { metric: "active_validators", value: "98", unitLabel: "" },
  { metric: "staking_apy_pct", value: "10.5", unitLabel: "" },
];

function authorized(req: Request): boolean {
  const secret = process.env.GENESIS_CRON_SECRET;
  if (chainMode() !== "real" && !secret) return true; // open in the credential-free demo
  if (!secret) return false;
  return req.headers.get("x-cron-secret") === secret;
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized: Genesis is gated by x-cron-secret" }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* body optional */
  }

  const network = isCasperNetwork(body.network) ? body.network : "testnet";
  const seq = listCreatedMarkets().length;
  const signal = SIGNALS[seq % SIGNALS.length];
  const trigger: GenesisTrigger = {
    metric: typeof body.metric === "string" ? body.metric : signal.metric,
    value: typeof body.value === "string" ? body.value : signal.value,
    unitLabel: typeof body.unitLabel === "string" ? body.unitLabel : signal.unitLabel,
    deadlineIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // one-hour window
    seq,
  };

  try {
    const market = await runGenesis(createContainer(network), trigger);
    return NextResponse.json({ created: market });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "genesis failed" },
      { status: 500 },
    );
  }
}
