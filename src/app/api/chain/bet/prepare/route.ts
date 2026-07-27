/**
 * POST /api/chain/bet/prepare — build a bet transaction for the VISITOR'S OWN wallet to sign.
 *
 * The self-custodial half of betting. `POST /api/chain/bet` signs with the operator key, so on
 * chain the bettor is the operator and the visitor's public key is a label; here the transaction
 * is built with the visitor as initiator, so their wallet signs it, their account pays the stake
 * and the gas, and `self.env().caller()` inside the contract is genuinely them — which is what
 * makes the winnings theirs to `claim`.
 *
 * Returns the unsigned transaction plus a ticket binding it to its future hash. See
 * `lib/bet-ticket.ts` for why the follow-up call cannot be trusted without one.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { validateBetRequest } from "@/lib/bet-request";
import { betTicketSecret, signBetTicket } from "@/lib/bet-ticket";
import { isSimulated } from "@/config/chain-mode";

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const validated = await validateBetRequest(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.rejection.error }, { status: validated.rejection.status });
  }
  const { network, market, outcomeKey, amountMotes, bettor } = validated.request;

  // A public key, not an agent label: this one has to be a real signer.
  if (!/^0[12][0-9a-fA-F]+$/.test(bettor)) {
    return NextResponse.json(
      { error: "bettor must be a Casper public key hex for a wallet-signed bet" },
      { status: 400 },
    );
  }

  const container = createContainer(network);
  // 501, not 500: the mock chain has no transaction to offer and never will. The client reads this
  // as "use the operator-signed route" rather than as a failure.
  if (!container.chain.buildBetTransaction) {
    return NextResponse.json(
      {
        error: isSimulated()
          ? "this deployment runs the simulated chain — wallet-signed bets need CASPER_CHAIN_MODE=real"
          : "this chain adapter cannot build unsigned transactions",
      },
      { status: 501 },
    );
  }

  const secret = betTicketSecret();
  if (!secret) {
    // Refuse rather than mint a ticket anyone could forge — an unsigned ticket would make the
    // confirm route trust its caller's numbers, which is the whole thing it exists to prevent.
    return NextResponse.json(
      { error: "server is missing a bet-ticket secret (set BET_TICKET_SECRET)" },
      { status: 500 },
    );
  }

  let unsigned;
  try {
    unsigned = await container.chain.buildBetTransaction({
      marketId: market.id,
      outcomeKey,
      amountMotes,
      bettor,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not build the bet transaction";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const ticket = signBetTicket(
    {
      network,
      marketId: market.id,
      outcomeKey,
      amountMotes,
      bettor,
      transactionHash: unsigned.transactionHash,
      issuedAtMs: Date.now(),
      custody: "self",
    },
    secret,
  );

  return NextResponse.json(
    {
      transactionJson: unsigned.transactionJson,
      transactionHash: unsigned.transactionHash,
      // The hash is final before the wallet signs, so its explorer link is too. Handing it back
      // here is what lets the panel render a receipt the instant the wallet submits, rather than
      // holding it until the transaction executes 8-16s later.
      explorerUrl: container.chain.explorerUrlForDeploy(unsigned.transactionHash),
      gasMotes: unsigned.gasMotes,
      ticket,
      network,
      marketId: market.id,
      outcomeKey,
      amountMotes,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
