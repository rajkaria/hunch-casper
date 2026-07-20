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
import { hydrateEconomyState, persistEconomyState } from "@/adapters/persist/economy-state";
import { runGenesis } from "@/agent/genesis";
import type { GenesisTrigger } from "@/agent/genesis";
import { listCreatedMarkets } from "@/adapters/mock/market-source";
import {
  abuseGuardsActive,
  cooldown,
  genesisCapReached,
  TRIGGER_LAST_RUN,
} from "@/lib/abuse-guards";
import { fetchLiveSignal } from "@/adapters/casper/chain-signals";
import { isCasperNetwork } from "@/config/network";
import type { CasperNetwork } from "@/config/network";
import { chainMode } from "@/config/chain-mode";

/**
 * The deterministic fallback rotation — used when the live sources (CSPR.cloud validators,
 * node-RPC block height; see `chain-signals.ts`) are unreachable, and always under test so the
 * suites stay hermetic. `CASPER_LIVE_SIGNALS=false` forces the rotation (offline demos).
 */
const SIGNALS: { metric: string; value: string; unitLabel: string }[] = [
  { metric: "cspr_usd", value: "0.05", unitLabel: "$" },
  { metric: "daily_deploys", value: "28000", unitLabel: "" },
  { metric: "active_validators", value: "98", unitLabel: "" },
  { metric: "staking_apy_pct", value: "10.5", unitLabel: "" },
];

/** A real chain signal when reachable, else the deterministic rotation. */
async function pickSignal(
  network: CasperNetwork,
  seq: number,
): Promise<{ metric: string; value: string; unitLabel: string; sourceLabel?: string }> {
  const liveAllowed = process.env.NODE_ENV !== "test" && process.env.CASPER_LIVE_SIGNALS !== "false";
  if (liveAllowed) {
    const live = await fetchLiveSignal(network);
    if (live) return live;
  }
  return SIGNALS[seq % SIGNALS.length];
}

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

  // Demo-surface abuse guards (not security — real mode is cron-secret-gated above): the open
  // mock-mode trigger gets a catalogue cap + 20s cooldown so a griefer can't spam markets into
  // the judged board. Skipped under test unless a suite opts in (ABUSE_GUARDS=on).
  if (abuseGuardsActive()) {
    const createdCount = listCreatedMarkets().length;
    if (genesisCapReached(createdCount)) {
      return NextResponse.json(
        { error: `genesis catalogue cap reached (${createdCount} markets created)` },
        { status: 409 },
      );
    }
    const waitMs = cooldown("genesis", Date.now(), 20_000, TRIGGER_LAST_RUN);
    if (waitMs > 0) {
      const retryAfterSec = Math.ceil(waitMs / 1000);
      return NextResponse.json(
        { error: `genesis cooldown: retry in ${retryAfterSec}s` },
        { status: 429, headers: { "retry-after": String(retryAfterSec) } },
      );
    }
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* body optional */
  }

  const network = isCasperNetwork(body.network) ? body.network : "testnet";
  const seq = listCreatedMarkets().length;
  // Explicit body params (demo/manual) win; otherwise a live chain signal, else the rotation.
  const signal =
    typeof body.metric === "string" && typeof body.value === "string"
      ? {
          metric: body.metric,
          value: body.value,
          unitLabel: typeof body.unitLabel === "string" ? body.unitLabel : "",
          sourceLabel: "operator",
        }
      : await pickSignal(network, seq);
  const trigger: GenesisTrigger = {
    metric: signal.metric,
    value: signal.value,
    unitLabel: signal.unitLabel,
    deadlineIso: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // one-hour window
    seq,
    sourceLabel: signal.sourceLabel,
  };

  try {
    // Create on top of the persisted economy and await the flush before responding — a genesis
    // market can be a REAL on-chain create, and a serverless freeze after a fire-and-forget
    // persist is how a market the chain has vanishes from the app (no-ops when KV is off).
    await hydrateEconomyState();
    const market = await runGenesis(createContainer(network), trigger);
    await persistEconomyState();
    return NextResponse.json({ created: market });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "genesis failed" },
      { status: 500 },
    );
  }
}
