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

  const container = createContainer(network);

  // Validate against the catalogue read model before touching the chain: the bet must be on a
  // real market and a real outcome of it. (Closes the S4-review correctness gap; safe because the
  // money path itself is pure-math + operator-custody, but a bet on a bad outcome is nonsense.)
  const slug = marketId.startsWith(`${network}:`) ? marketId.slice(network.length + 1) : marketId;
  const market = await container.store.get(slug, network);
  if (!market) {
    return NextResponse.json({ error: `unknown market '${marketId}'` }, { status: 400 });
  }
  if (!market.outcomes.some((o) => o.key === outcomeKey)) {
    return NextResponse.json({ error: `'${outcomeKey}' is not an outcome of ${marketId}` }, { status: 400 });
  }
  if (market.status !== "open") {
    return NextResponse.json({ error: `market ${marketId} is ${market.status}` }, { status: 409 });
  }

  // Phase 1 — submit the escrow to the chain (the money authority). A failure here means no
  // value moved, so it is the only case that returns 502.
  let res;
  try {
    res = await container.chain.placeBet({ marketId: market.id, outcomeKey, amountMotes, bettor });
  } catch (err) {
    const message = err instanceof Error ? err.message : "chain submission failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Phase 2 — index the escrowed bet so pools + odds go live. The chain already accepted the bet;
  // if indexing fails (e.g. a concurrent resolve flipped the market between the pre-flight check
  // and here), we must NOT report a chain failure and lose the escrowed bet. Surface it distinctly
  // (`indexed: false` + the deploy hash) so it can be reconciled from chain state — closing the
  // orphaned-settlement class the S5 review flagged.
  try {
    const updated = await container.store.recordBet({ marketId: market.id, bettor, outcomeKey, amountMotes });
    return NextResponse.json({
      deployHash: res.deployHash,
      explorerUrl: res.explorerUrl,
      network,
      marketId: market.id,
      outcomeKey,
      amountMotes,
      indexed: true,
      totalStakedMotes: updated.totalStakedMotes,
      poolByOutcomeMotes: updated.poolByOutcomeMotes,
      simulated: isSimulated(),
    });
  } catch (recordErr) {
    const message = recordErr instanceof Error ? recordErr.message : "off-chain indexing failed";
    return NextResponse.json({
      deployHash: res.deployHash,
      explorerUrl: res.explorerUrl,
      network,
      marketId: market.id,
      outcomeKey,
      amountMotes,
      indexed: false,
      indexError: message,
      simulated: isSimulated(),
    });
  }
}
