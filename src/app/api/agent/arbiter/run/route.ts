/**
 * POST /api/agent/arbiter/run — fire the Arbiter.
 *
 * With no target it sweeps and resolves every matured market (past deadline, unsettled) — the
 * unattended path a cron drives. With `{ slug }` (or `marketId`) it resolves that one market now —
 * the weekly close for a meta-market, so its settlement against the live boards is demoable.
 *
 * Resolution is a money-path authority. Open in the credential-free mock/demo; in real mode it is
 * gated by `ARBITER_CRON_SECRET` (x-cron-secret header), since the server holds the oracle key.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { resolveMarket, runArbiterSweep } from "@/agent/arbiter";
import { isCasperNetwork } from "@/config/network";
import { chainMode } from "@/config/chain-mode";

function authorized(req: Request): boolean {
  const secret = process.env.ARBITER_CRON_SECRET;
  if (chainMode() !== "real" && !secret) return true; // open in the credential-free demo
  if (!secret) return false;
  return req.headers.get("x-cron-secret") === secret;
}

export async function POST(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized: the Arbiter is gated by x-cron-secret" }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* body optional */
  }

  const network = isCasperNetwork(body.network) ? body.network : "testnet";
  const container = createContainer(network);

  // Accept an explicit target as `slug` or `marketId` (`network:slug`).
  const rawTarget =
    typeof body.slug === "string" && body.slug.length > 0
      ? body.slug
      : typeof body.marketId === "string" && body.marketId.length > 0
        ? body.marketId
        : null;

  if (rawTarget) {
    const slug = rawTarget.startsWith(`${network}:`) ? rawTarget.slice(network.length + 1) : rawTarget;
    const action = await resolveMarket(container, slug);
    if (!action) {
      return NextResponse.json(
        { resolved: 0, actions: [], note: `'${slug}' is unknown or already settled` },
        { status: 200 },
      );
    }
    return NextResponse.json({ resolved: 1, actions: [action] });
  }

  const actions = await runArbiterSweep(container);
  return NextResponse.json({ resolved: actions.length, actions });
}
