/**
 * POST /api/chain/bet/confirm — index a bet the visitor's own wallet signed and submitted.
 *
 * The second half of the self-custodial flow. Every term of the bet is read from the ticket
 * `prepare` signed, never from this request body: the caller supplies a ticket and nothing else
 * that matters, so there is no field to inflate. See `lib/bet-ticket.ts`.
 *
 * The two-phase shape mirrors `POST /api/chain/bet` exactly — confirm on chain first (the money
 * authority), then index — including its distinction between "the chain rejected this" (no value
 * moved) and "the chain took it but indexing failed" (`indexed: false`, so an escrowed bet is never
 * silently lost to a read-model error).
 *
 * ## Why this ANSWERS rather than waits
 *
 * It used to block in `awaitExecution` until the transaction executed — up to 150s, ~10-20s
 * typically (testnet blocks land every 8s and `execution_info` appears within one or two of them).
 * The visitor saw none of that: the panel rendered nothing until this responded, so a transaction
 * the chain already held sat invisible behind the wait, with no hash to copy and no explorer link
 * to follow. The hash is known BEFORE any of it — `prepare` returns it and the wallet returns it
 * again at submit — and withholding what we already know buys nothing.
 *
 * So each call is one read and one answer: `pending`, `confirmed` or `reverted`. The client shows
 * the receipt at submit and polls this until it turns terminal. Correctness is unchanged — nothing
 * is indexed until the chain reports a successful execution, and a timeout is the client's problem
 * to display rather than a reason to claim a bet happened.
 *
 * Polling means the same executed transaction is observed more than once, so indexing is at-most-
 * once on the transaction hash (`dedupeKey`) — otherwise two polls would stake it twice.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { betTicketSecret, verifyBetTicket } from "@/lib/bet-ticket";
import { isCasperNetwork } from "@/config/network";
import { isSimulated } from "@/config/chain-mode";
import { persistEconomyState } from "@/adapters/persist/economy-state";
import type { TransactionStatus } from "@/ports/casper-chain";

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
  if (!container.chain.checkTransaction && !container.chain.confirmTransaction) {
    return NextResponse.json(
      {
        error: isSimulated()
          ? "this deployment runs the simulated chain — wallet-signed bets need CASPER_CHAIN_MODE=real"
          : "this chain adapter cannot confirm externally-submitted transactions",
      },
      { status: 501 },
    );
  }

  // Phase 1 — what does the chain say right now? A reverted or never-executed transaction is not a
  // bet, and indexing one would put money on the boards that no vault is holding.
  let state: TransactionStatus;
  try {
    state = container.chain.checkTransaction
      ? await container.chain.checkTransaction(transactionHash)
      : // An adapter that can only block still works, it just costs the visitor the wait.
        { status: "confirmed", result: await container.chain.confirmTransaction!(transactionHash) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "chain confirmation failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const receipt = {
    deployHash: transactionHash,
    explorerUrl: container.chain.explorerUrlForDeploy(transactionHash),
    network,
    marketId,
    outcomeKey,
    amountMotes,
    // Absent on a ticket minted before the operator path issued them — those only ever came from
    // `prepare`, which is self-custodial by definition.
    selfCustodial: claims.custody !== "operator",
    simulated: isSimulated(),
  };

  // Still in the mempool or in an unexecuted block. 200, not an error: nothing is wrong — the
  // client keeps its receipt on screen and asks again.
  if (state.status === "pending") {
    return NextResponse.json({ ...receipt, status: "pending" }, { headers: { "cache-control": "no-store" } });
  }
  if (state.status === "reverted") {
    return NextResponse.json(
      { ...receipt, status: "reverted", error: `transaction reverted on chain: ${state.error}` },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // Phase 2 — index it. The chain has already accepted the escrow at this point, so an indexing
  // failure must NOT be reported as a chain failure.
  try {
    const updated = await container.store.recordBet({
      marketId,
      bettor,
      outcomeKey,
      amountMotes,
      // At-most-once on the transaction: a poll that races another, or a client that retries, must
      // not stake the same escrow twice. See `ledgerRecordBet`.
      dedupeKey: `${network}:${transactionHash}`,
    });
    // Same flush discipline as the operator-signed route: await the write before responding, so
    // the pools the page refetches a moment later already include this bet on every instance.
    await persistEconomyState();
    return NextResponse.json(
      {
        ...receipt,
        status: "confirmed",
        indexed: true,
        totalStakedMotes: updated.totalStakedMotes,
        poolByOutcomeMotes: updated.poolByOutcomeMotes,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (recordErr) {
    const message = recordErr instanceof Error ? recordErr.message : "off-chain indexing failed";
    return NextResponse.json(
      { ...receipt, status: "confirmed", indexed: false, indexError: message },
      { headers: { "cache-control": "no-store" } },
    );
  }
}
