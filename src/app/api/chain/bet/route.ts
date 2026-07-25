/**
 * POST /api/chain/bet — escrow a stake into a market's parimutuel vault.
 *
 * The server picks the adapter (mock today; real Casper when the container is in real mode),
 * so this route is byte-identical whether it settles a pseudo hash or a live testnet deploy.
 * It is the S2 "place a bet end-to-end from the UI" seam.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { validateBetRequest } from "@/lib/bet-request";
import { isSimulated } from "@/config/chain-mode";

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Shared with `/api/chain/bet/prepare` so the operator-signed and wallet-signed paths cannot
  // drift on caps, unknown markets, or a closed market. See `lib/bet-request.ts`.
  const validated = await validateBetRequest(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.rejection.error }, { status: validated.rejection.status });
  }
  const { network, market, outcomeKey, amountMotes, bettor } = validated.request;
  const container = createContainer(network);

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
