/**
 * POST /api/markets/create/finalize — register a market the visitor's own wallet opened on chain.
 *
 * The second half of the self-custodial flow. Every term of the market is read from the ticket
 * `prepare` signed, never from this request body: the caller supplies the ticket and nothing else
 * that matters, so there is no field to inflate. See `lib/creation-ticket.ts`.
 *
 * The shape mirrors `/api/chain/bet/confirm` exactly: one chain read and one answer per call —
 * `pending` (keep polling), `reverted` (the vault refused it; only gas was spent, the bond
 * returned with the revert), or `created` (executed → recompose from the ticket, register, seed,
 * persist). Nothing is registered until the chain reports a successful execution, so the boards
 * can never show a market the vault does not hold.
 *
 * Polling means the same executed transaction is observed more than once, so registration is
 * idempotent on the slug: a second confirmed poll answers `created` again rather than erroring on
 * "already exists" — the market IS created, and that is the answer.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { composeForCreation, definitionForSlug, registerComposedMarket } from "@/lib/market-create";
import { hydrateEconomyState, persistEconomyState } from "@/adapters/persist/economy-state";
import { isCasperNetwork } from "@/config/network";
import { isSimulated } from "@/config/chain-mode";
import { betTicketSecret } from "@/lib/bet-ticket";
import { verifyCreationTicket } from "@/lib/creation-ticket";
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
    return NextResponse.json({ error: "server is missing a ticket secret" }, { status: 500 });
  }
  const claims = verifyCreationTicket(body?.ticket, secret);
  if (!claims) {
    // One answer for a forged MAC, a mangled payload and an expired ticket alike.
    return NextResponse.json({ error: "invalid or expired creation ticket" }, { status: 400 });
  }
  if (!isCasperNetwork(claims.network)) {
    return NextResponse.json({ error: "ticket names an unknown network" }, { status: 400 });
  }

  const container = createContainer(claims.network);
  if (!container.chain.checkTransaction && !container.chain.confirmTransaction) {
    return NextResponse.json(
      {
        error: isSimulated()
          ? "this deployment runs the simulated chain — wallet-signed creation needs CASPER_CHAIN_MODE=real"
          : "this chain adapter cannot confirm externally-submitted transactions",
      },
      { status: 501 },
    );
  }

  // Phase 1 — what does the chain say right now? A reverted or never-executed `create_market` is
  // not a market, and registering one would put a board up that no vault is holding.
  let state: TransactionStatus;
  try {
    state = container.chain.checkTransaction
      ? await container.chain.checkTransaction(claims.transactionHash)
      : { status: "confirmed", result: await container.chain.confirmTransaction!(claims.transactionHash) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "chain confirmation failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const receipt = {
    deployHash: claims.transactionHash,
    explorerUrl: container.chain.explorerUrlForDeploy(claims.transactionHash),
    network: claims.network,
    slug: claims.slug,
    recipeHash: claims.recipeHash,
    simulated: isSimulated(),
  };

  if (state.status === "pending") {
    // Still in the mempool or an unexecuted block. 200, not an error: the client keeps its
    // receipt on screen and asks again.
    return NextResponse.json({ ...receipt, status: "pending" }, { headers: { "cache-control": "no-store" } });
  }
  if (state.status === "reverted") {
    return NextResponse.json(
      {
        ...receipt,
        status: "reverted",
        // The bond travelled inside the reverted transaction, so it came back with it — only the
        // gas was spent. Said explicitly, because "creation failed" after a wallet approval reads
        // like lost money.
        error: `the vault refused this creation: ${state.error} — the bond was returned with the revert; only gas was spent`,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // Phase 2 — the chain holds the market; mirror it. Hydrate first so the registration lands on
  // the persisted economy, not a cold instance's empty seed.
  await hydrateEconomyState();

  // A previous poll (or a sibling instance) may have registered it already — that is success.
  if (definitionForSlug(claims.slug)) {
    return NextResponse.json(
      { ...receipt, status: "created", seededBets: 0, alreadyRegistered: true },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // Recompose from the ticket's own spec — never the request body — and require the recompose to
  // land on the recipe hash the ticket committed to. Composition is deterministic on these inputs,
  // so a mismatch means the claims were not what prepare signed; refuse rather than register.
  const composed = await composeForCreation(
    container,
    { ...claims.spec, oracle: claims.oracle },
    { skipDuplicateCheck: true },
  );
  if (!composed.ok) {
    return NextResponse.json({ error: composed.error, reason: composed.reason }, { status: composed.code });
  }
  if (composed.recipeHash !== claims.recipeHash || composed.definition.slug !== claims.slug) {
    return NextResponse.json(
      { error: "recomposed market does not match the ticket's commitments" },
      { status: 409 },
    );
  }

  const result = await registerComposedMarket(container, composed.definition, composed.recipeHash, {
    receipt: { deployHash: claims.transactionHash, explorerUrl: receipt.explorerUrl },
    seedByFleet: claims.seedByFleet,
    seq: claims.spec.seq,
  });
  if (result.status !== "created") {
    // The chain holds the market either way; surface the indexing failure distinctly rather than
    // pretending the creation failed — same honesty rule as a bet that indexes late.
    const message = result.status === "error" ? result.error : "registration did not complete";
    return NextResponse.json(
      { ...receipt, status: "created", seededBets: 0, indexed: false, indexError: message },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // Await the flush: a 200 names a REAL on-chain market, and a serverless instance may freeze the
  // moment the response returns.
  await persistEconomyState();

  return NextResponse.json(
    { ...receipt, status: "created", seededBets: result.seededBets, selfCustodial: true },
    { headers: { "cache-control": "no-store" } },
  );
}
