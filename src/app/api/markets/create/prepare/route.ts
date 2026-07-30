/**
 * POST /api/markets/create/prepare — build a `create_market` transaction for the CREATOR'S OWN
 * wallet to sign.
 *
 * The self-custodial half of market creation, and the thing that makes the bond genuinely
 * refundable. The x402 path submits `create_market` with the operator key, so on chain the
 * creator is the operator and the vault's settlement-time bond refund lands with the operator —
 * the visitor's transfer to the treasury is held, not returned. Here the transaction is built
 * with the visitor as initiator: their wallet signs it, their account attaches the bond and pays
 * the gas, `env().caller()` inside the vault is genuinely them — and `refund_bond` pays
 * `config.creator`, i.e. THEM, when the market settles cleanly. Same move betting made in
 * `/api/chain/bet/prepare`, for the same reason.
 *
 * Because the caller is no longer the vault admin, the S19 public-creation guardrails apply on
 * chain for the first time — approved non-self oracle, fee ≤ 5%, deadline within 180 days, open-
 * market cap. The ones that are checkable offline are checked HERE, before any wallet opens: a
 * revert after signing costs the visitor real gas, and "the chain refused it" is a much worse
 * error message than a 400 naming the field.
 *
 * Returns the unsigned transaction plus a ticket binding the ENTIRE composed spec to its future
 * hash — see `lib/creation-ticket.ts` for why `finalize` cannot be trusted without one.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { composeForCreation, creationBondPaymentBlocker } from "@/lib/market-create";
import type { CreateMarketRequest } from "@/lib/market-create";
import { hydrateEconomyState } from "@/adapters/persist/economy-state";
import { listCreatedMarkets } from "@/adapters/mock/market-source";
import { isCasperNetwork } from "@/config/network";
import { isSimulated } from "@/config/chain-mode";
import { oracleAccount } from "@/agent/genesis";
import { betTicketSecret } from "@/lib/bet-ticket";
import { signCreationTicket } from "@/lib/creation-ticket";
import type { ComposeMarketInput } from "@/core/market-composer";
import type { ResolverComparator, ResolverKind, ResolverSource, MarketOutcome } from "@/core/types";

/** The wallet has to be able to sign as this account — a label cannot. */
const PUBLIC_KEY_HEX = /^0[12][0-9a-fA-F]{64,128}$/;

/**
 * The vault's S19 public-creation caps, transcribed from `contracts/src/hunch_vault.rs`
 * (`MAX_PUBLIC_FEE_BPS`, `MAX_PUBLIC_DEADLINE_HORIZON_MS`, `MAX_QUESTION_LEN`). Kept in step
 * deliberately: a divergence does not fail at build time, it reverts on chain after the visitor
 * has signed and paid gas.
 */
const VAULT_MAX_PUBLIC_FEE_BPS = 500;
const VAULT_MAX_DEADLINE_HORIZON_MS = 180 * 24 * 60 * 60 * 1_000;
const VAULT_MAX_QUESTION_LEN = 200;

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { network } = body ?? {};
  if (!isCasperNetwork(network)) {
    return NextResponse.json({ error: "network must be 'testnet' or 'mainnet'" }, { status: 400 });
  }
  const creator = String(body.creator ?? "").trim();
  if (!PUBLIC_KEY_HEX.test(creator)) {
    return NextResponse.json(
      { error: "creator must be a Casper public key hex — connect a wallet to sign the creation" },
      { status: 400 },
    );
  }

  const container = createContainer(network);
  // 501, not 500: the mock chain has no transaction to hand to a wallet and never will. The
  // create page reads this as "use the demo handshake" rather than as a failure.
  if (!container.chain.buildCreateMarketTransaction) {
    return NextResponse.json(
      {
        error: isSimulated()
          ? "this deployment runs the simulated chain — wallet-signed creation needs CASPER_CHAIN_MODE=real"
          : "this chain adapter cannot build unsigned transactions",
      },
      { status: 501 },
    );
  }
  const secret = betTicketSecret();
  if (!secret) {
    // Refuse rather than mint a ticket anyone could forge — see `/api/chain/bet/prepare`.
    return NextResponse.json(
      { error: "server is missing a ticket secret (set BET_TICKET_SECRET)" },
      { status: 500 },
    );
  }

  const blocker = creationBondPaymentBlocker();
  if (blocker) return NextResponse.json({ error: blocker }, { status: 503 });

  // The oracle defaults to the deployment's approved account — served by GET /api/markets/create
  // too, so a client that omits it and the form that prefills it agree.
  const oracle = String(body.oracle ?? oracleAccount() ?? "").trim();

  // Compose on top of the persisted economy — the slug seq and the duplicate check both read the
  // created-markets list, exactly as the x402 route does.
  await hydrateEconomyState();

  const spec: ComposeMarketInput = {
    claim: String(body.claim ?? ""),
    creator,
    network,
    seq: listCreatedMarkets().length,
    deadlineIso: String(body.deadlineIso ?? ""),
    source: body.source as ResolverSource,
    metric: String(body.metric ?? ""),
    method: body.method as ResolverKind,
    target: body.target === undefined ? undefined : String(body.target),
    comparator: body.comparator === undefined ? undefined : (body.comparator as ResolverComparator),
    outcomes: Array.isArray(body.outcomes) ? (body.outcomes as MarketOutcome[]) : undefined,
    feeBps: typeof body.feeBps === "number" ? body.feeBps : undefined,
  };
  const request: CreateMarketRequest = { ...spec, oracle };

  const composed = await composeForCreation(container, request);
  if (!composed.ok) {
    return NextResponse.json({ error: composed.error, reason: composed.reason }, { status: composed.code });
  }
  const { definition, recipeHash, bondMotes } = composed;

  // The offline-checkable S19/structural caps — reject before the wallet opens, not after gas.
  if (definition.feeBps > VAULT_MAX_PUBLIC_FEE_BPS) {
    return NextResponse.json(
      { error: `public creation caps the fee at ${VAULT_MAX_PUBLIC_FEE_BPS} bps (5%), got ${definition.feeBps}` },
      { status: 400 },
    );
  }
  const deadlineMs = Date.parse(definition.deadlineIso);
  if (deadlineMs - Date.now() > VAULT_MAX_DEADLINE_HORIZON_MS) {
    return NextResponse.json(
      { error: "public creation caps the deadline at 180 days out — bettor funds are escrowed until it" },
      { status: 400 },
    );
  }
  if (deadlineMs <= Date.now()) {
    return NextResponse.json({ error: "the deadline is already in the past" }, { status: 400 });
  }
  if (definition.title.length > VAULT_MAX_QUESTION_LEN) {
    // A 200-char claim gains a "?" in composition and busts the vault's own cap by one.
    return NextResponse.json(
      { error: `the question is ${definition.title.length} characters; the vault caps it at ${VAULT_MAX_QUESTION_LEN}` },
      { status: 400 },
    );
  }

  let unsigned;
  try {
    unsigned = await container.chain.buildCreateMarketTransaction({
      marketId: definition.slug,
      question: definition.title,
      category: definition.category,
      oracle,
      feeBps: definition.feeBps,
      deadlineMs,
      outcomeKeys: definition.outcomes.map((o) => o.key),
      bondMotes,
      creator,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not build the creation transaction";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const ticket = signCreationTicket(
    {
      network,
      slug: definition.slug,
      spec,
      oracle,
      recipeHash,
      bondMotes,
      transactionHash: unsigned.transactionHash,
      seedByFleet: body.seedByFleet !== false,
      issuedAtMs: Date.now(),
    },
    secret,
  );

  return NextResponse.json(
    {
      transactionJson: unsigned.transactionJson,
      transactionHash: unsigned.transactionHash,
      // Final before the wallet signs — the receipt renders the moment the wallet submits.
      explorerUrl: container.chain.explorerUrlForDeploy(unsigned.transactionHash),
      gasMotes: unsigned.gasMotes,
      bondMotes,
      recipeHash,
      slug: definition.slug,
      ticket,
      network,
      oracle,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
