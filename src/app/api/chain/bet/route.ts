/**
 * POST /api/chain/bet — escrow a stake into a market's parimutuel vault.
 *
 * The server picks the adapter (mock today; real Casper when the container is in real mode),
 * so this route is byte-identical whether it settles a pseudo hash or a live testnet deploy.
 * It is the S2 "place a bet end-to-end from the UI" seam.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { getNetworkConfig, isCasperNetwork } from "@/config/network";
import { isSimulated } from "@/config/chain-mode";
import { motesToCspr } from "@/core/types";

const MOTES = /^\d+$/;

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { network, marketId, outcomeKey, amountMotes, bettor } = body ?? {};

  if (!isCasperNetwork(network)) {
    return NextResponse.json({ error: "network must be 'testnet' or 'mainnet'" }, { status: 400 });
  }
  if (typeof marketId !== "string" || marketId.length === 0) {
    return NextResponse.json({ error: "marketId is required" }, { status: 400 });
  }
  if (typeof outcomeKey !== "string" || outcomeKey.length === 0) {
    return NextResponse.json({ error: "outcomeKey is required" }, { status: 400 });
  }
  if (typeof amountMotes !== "string" || !MOTES.test(amountMotes) || BigInt(amountMotes) <= 0n) {
    return NextResponse.json({ error: "amountMotes must be a positive integer motes string" }, { status: 400 });
  }
  if (typeof bettor !== "string" || bettor.length === 0) {
    return NextResponse.json({ error: "bettor is required" }, { status: 400 });
  }

  // Mainnet guardrail: fresh unaudited contracts hold real value, so bets are capped.
  const cfg = getNetworkConfig(network);
  const cap = cfg.guardrails.maxBetCspr;
  if (cap != null && motesToCspr(amountMotes) > cap) {
    return NextResponse.json(
      { error: `bet exceeds the ${network} cap of ${cap} CSPR` },
      { status: 400 },
    );
  }

  try {
    const container = createContainer(network);
    const res = await container.chain.placeBet({ marketId, outcomeKey, amountMotes, bettor });
    return NextResponse.json({
      deployHash: res.deployHash,
      explorerUrl: res.explorerUrl,
      network,
      marketId,
      outcomeKey,
      amountMotes,
      simulated: isSimulated(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "chain submission failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
