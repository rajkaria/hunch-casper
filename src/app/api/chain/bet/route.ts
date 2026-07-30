/**
 * POST /api/chain/bet — escrow a stake into a market's parimutuel vault.
 *
 * The server picks the adapter (mock today; real Casper when the container is in real mode),
 * so this route is byte-identical whether it settles a pseudo hash or a live testnet deploy.
 * It is the S2 "place a bet end-to-end from the UI" seam.
 *
 * The operator-signed path: the operator's key pays, and the caller's public key is a label on the
 * stake. The visitor's own wallet takes the money path instead wherever it can sign — see
 * `/api/chain/bet/prepare`.
 *
 * ## Two answers, depending on what the adapter can do
 *
 * On an adapter that can submit without waiting (`submitBet` — the real chain), this responds the
 * moment a node accepts the transaction, with the hash and a ticket, and the client polls
 * `/api/chain/bet/confirm` for the outcome. Nothing is indexed here: a queued transaction can still
 * revert, and the pools may only move on a confirmed execution.
 *
 * On an adapter whose submit is already instantaneous (the mock), `placeBet` confirms inline and
 * the bet is indexed in this same request, exactly as before — there is no wait to spare anyone.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { validateBetRequest } from "@/lib/bet-request";
import { betTicketSecret, signBetTicket } from "@/lib/bet-ticket";
import { isSimulated, chainMode } from "@/config/chain-mode";
import { persistEconomyState } from "@/adapters/persist/economy-state";
import { cooldown, TRIGGER_LAST_RUN } from "@/lib/abuse-guards";
import { motesToCspr } from "@/core/types";

/**
 * Real-mode guards for THIS route only. Operator custody means the operator's key signs and the
 * operator's purse pays gas + stake for whoever asks — unauthenticated and, on testnet, uncapped,
 * a curl loop could drain the treasury. The wallet-signed path (`prepare`/`confirm`) needs
 * neither: it spends the caller's own funds. Both are demo-grade (per-instance memory), which
 * moves the attack from "free" to "throttled per instance" without adding auth to a public demo.
 */
const OPERATOR_CUSTODY_MAX_CSPR = 25;
const OPERATOR_CUSTODY_COOLDOWN_MS = 15_000;

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

  if (chainMode() === "real") {
    if (motesToCspr(amountMotes) > OPERATOR_CUSTODY_MAX_CSPR) {
      return NextResponse.json(
        {
          error: `operator-custody bets are capped at ${OPERATOR_CUSTODY_MAX_CSPR} CSPR — sign larger stakes from your own wallet via /api/chain/bet/prepare`,
        },
        { status: 400 },
      );
    }
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    const waitMs = cooldown(`chain-bet:${ip}`, Date.now(), OPERATOR_CUSTODY_COOLDOWN_MS, TRIGGER_LAST_RUN);
    if (waitMs > 0) {
      const retryAfterSec = Math.ceil(waitMs / 1000);
      return NextResponse.json(
        { error: `operator-custody bet cooldown: retry in ${retryAfterSec}s` },
        { status: 429, headers: { "retry-after": String(retryAfterSec) } },
      );
    }
  }

  const container = createContainer(network);
  const input = { marketId: market.id, outcomeKey, amountMotes, bettor };

  // ── Fast path: submit now, confirm later ──────────────────────────────────────────────────────
  // Only when the client can actually follow up. A ticket is what makes that follow-up safe (the
  // terms are read from the MAC, never from the caller), so no secret means no split — fall through
  // to the blocking path rather than hand out an unpollable hash.
  const secret = betTicketSecret();
  if (container.chain.submitBet && container.chain.checkTransaction && secret) {
    let res;
    try {
      res = await container.chain.submitBet(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : "chain submission failed";
      return NextResponse.json({ error: message }, { status: 502 });
    }
    const ticket = signBetTicket(
      {
        network,
        marketId: market.id,
        outcomeKey,
        amountMotes,
        bettor,
        transactionHash: res.deployHash,
        issuedAtMs: Date.now(),
        custody: "operator",
      },
      secret,
    );
    return NextResponse.json(
      {
        deployHash: res.deployHash,
        explorerUrl: res.explorerUrl,
        network,
        marketId: market.id,
        outcomeKey,
        amountMotes,
        // Submitted, not executed — so NOT indexed, and the pools have not moved. The client polls
        // `confirm` with this ticket and updates when the chain has actually taken it.
        status: "pending",
        ticket,
        simulated: isSimulated(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  // ── Blocking path: this adapter's submit already includes confirmation ────────────────────────
  // Phase 1 — submit the escrow to the chain (the money authority). A failure here means no
  // value moved, so it is the only case that returns 502.
  let res;
  try {
    res = await container.chain.placeBet(input);
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
    // No `dedupeKey` here, deliberately. This path indexes exactly once per request — there is no
    // poll to race — and the hash it would key on is not an identifier of a submission on every
    // adapter: the mock derives a DETERMINISTIC pseudo hash from the bet's terms, so keying on it
    // would read a visitor's second identical 1 CSPR bet as a replay of their first and silently
    // drop it. At-most-once belongs to the polled path, which has real transaction hashes.
    const updated = await container.store.recordBet({
      marketId: market.id,
      bettor,
      outcomeKey,
      amountMotes,
    });
    // AWAIT the flush the store fired: a serverless instance can freeze the moment this response
    // is sent, and the page refetches pools immediately afterwards — a fire-and-forget persist
    // would let that refetch land on a sibling instance and render the bet as never placed.
    await persistEconomyState();
    return NextResponse.json({
      deployHash: res.deployHash,
      explorerUrl: res.explorerUrl,
      network,
      marketId: market.id,
      outcomeKey,
      amountMotes,
      status: "confirmed",
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
      status: "confirmed",
      indexed: false,
      indexError: message,
      simulated: isSimulated(),
    });
  }
}
