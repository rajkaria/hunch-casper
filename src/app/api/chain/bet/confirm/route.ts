/**
 * POST /api/chain/bet/confirm — index a bet the visitor's own wallet signed and submitted.
 *
 * The second half of the self-custodial flow. Every term of the bet is read from the ticket
 * `prepare` signed, never from this request body: the caller supplies a ticket and nothing else
 * that matters, so there is no field to inflate. See `lib/bet-ticket.ts`.
 *
 * The two-phase shape mirrors `POST /api/chain/bet` exactly — confirm on chain first (the money
 * authority), then index — including its distinction between "the chain rejected this" (502, no
 * value moved) and "the chain took it but indexing failed" (200 with `indexed: false`, so an
 * escrowed bet is never silently lost to a read-model error).
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { betTicketSecret, verifyBetTicket } from "@/lib/bet-ticket";
import { isCasperNetwork } from "@/config/network";
import { isSimulated } from "@/config/chain-mode";

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const secret = betTicketSecret();
  if (!secret) {
    return NextResponse.json({ error: "server is missing a bet-ticket secret" }, { status: 500 });
  }

  const claims = verifyBetTicket(body?.ticket, secret);
  if (!claims) {
    // One answer for a forged MAC, a mangled payload and an expired ticket alike: distinguishing
    // them tells a forger which half to work on.
    return NextResponse.json({ error: "invalid or expired bet ticket" }, { status: 400 });
  }
  if (!isCasperNetwork(claims.network)) {
    return NextResponse.json({ error: "ticket names an unknown network" }, { status: 400 });
  }

  const { network, marketId, outcomeKey, amountMotes, bettor, transactionHash } = claims;
  const container = createContainer(network);
  if (!container.chain.confirmTransaction) {
    return NextResponse.json(
      {
        error: isSimulated()
          ? "this deployment runs the simulated chain — wallet-signed bets need CASPER_CHAIN_MODE=real"
          : "this chain adapter cannot confirm externally-submitted transactions",
      },
      { status: 501 },
    );
  }

  // Phase 1 — did it actually execute? A reverted or never-executed transaction is not a bet, and
  // indexing one would put money on the boards that no vault is holding.
  let res;
  try {
    res = await container.chain.confirmTransaction(transactionHash);
  } catch (err) {
    const message = err instanceof Error ? err.message : "chain confirmation failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Phase 2 — index it. The chain has already accepted the escrow at this point, so an indexing
  // failure must NOT be reported as a chain failure.
  try {
    const updated = await container.store.recordBet({ marketId, bettor, outcomeKey, amountMotes });
    return NextResponse.json({
      deployHash: res.deployHash,
      explorerUrl: res.explorerUrl,
      network,
      marketId,
      outcomeKey,
      amountMotes,
      indexed: true,
      selfCustodial: true,
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
      marketId,
      outcomeKey,
      amountMotes,
      indexed: false,
      selfCustodial: true,
      indexError: message,
      simulated: isSimulated(),
    });
  }
}
