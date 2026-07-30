/**
 * The creation bond's money path — build the transfer, then watch it land.
 *
 * `POST` returns an UNSIGNED native CSPR transfer of the bond from the visitor's account to the
 * operator treasury (`CASPER_X402_PAYTO`), for their own wallet to sign. `GET ?hash=…` reports what
 * the chain currently says about it. Together they are what makes `POST /api/markets/create`'s
 * x402 proof real: the hash the visitor's wallet submits IS the settlement the transfer-verifying
 * `PaymentPort` looks up, initiated by them, paid to the treasury, for at least the bond.
 *
 * The create page used to fabricate a `demo-<nonce>-…` settlement id here instead. The mock rail
 * accepted it, so it looked fine in development; production runs the real rail, which requires a
 * 64-hex on-chain transaction — so every live creation died on "invalid or unverifiable
 * creation-bond payment", with no way for a visitor to do anything about it.
 *
 * The shape mirrors `/api/chain/bet/prepare` deliberately: same 501-means-fall-back contract, same
 * "the hash is final before the signature" receipt. There is no bet ticket, because there is
 * nothing to bind — this route neither indexes nor spends anything; `createMarket` re-derives the
 * requirement and verifies the proof against the chain itself.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { isCasperNetwork } from "@/config/network";
import { isSimulated } from "@/config/chain-mode";
import { bondPayTo, creationBondMotes, creationBondPaymentBlocker } from "@/lib/market-create";

/** A Casper public key hex — the wallet has to be able to sign as this account. */
const PUBLIC_KEY_HEX = /^0[12][0-9a-fA-F]{64,128}$/;
/** A 32-byte transaction hash, the only thing worth asking a node about. */
const TX_HASH = /^[0-9a-fA-F]{64}$/;

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
      { error: "creator must be a Casper public key hex — connect a wallet to pay the bond" },
      { status: 400 },
    );
  }

  const container = createContainer(network);
  // 501, not 500: the mock chain has no transfer to offer and never will, and the create page
  // reads this as "this deployment settles bonds off-chain" rather than as a failure.
  if (!container.chain.buildTransferTransaction) {
    return NextResponse.json(
      {
        error: isSimulated()
          ? "this deployment runs the simulated chain — a wallet-paid bond needs CASPER_CHAIN_MODE=real"
          : "this chain adapter cannot build unsigned transfers",
      },
      { status: 501 },
    );
  }
  const payTo = process.env.CASPER_X402_PAYTO;
  if (!payTo) {
    // Without a treasury there is nowhere trustless to pay, and `createMarket` would be accepting
    // unverified bonds anyway. Say which variable is missing rather than build a transfer to a
    // placeholder account.
    return NextResponse.json(
      { error: "no bond treasury configured — set CASPER_X402_PAYTO" },
      { status: 501 },
    );
  }

  const amountMotes = creationBondMotes();
  const blocker = creationBondPaymentBlocker(amountMotes);
  if (blocker) return NextResponse.json({ error: blocker }, { status: 503 });

  let unsigned;
  try {
    unsigned = await container.chain.buildTransferTransaction({
      from: creator,
      to: bondPayTo(),
      amountMotes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not build the bond transfer";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  return NextResponse.json(
    {
      transactionJson: unsigned.transactionJson,
      transactionHash: unsigned.transactionHash,
      explorerUrl: container.chain.explorerUrlForDeploy(unsigned.transactionHash),
      gasMotes: unsigned.gasMotes,
      amountMotes,
      payTo: bondPayTo(),
      network,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * One read of what the chain says about a submitted bond transfer.
 *
 * The create route's own verifier waits a bounded few seconds for a young transaction, which is
 * not enough to cover a wallet submit racing an 8-16s block — and a `402` from that race is
 * indistinguishable, to a visitor, from a bond that was never paid. So the browser polls this
 * until the transfer has actually executed and only then retries the creation. Nothing here is
 * trusted input: the hash names a transaction, and the chain answers.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const network = url.searchParams.get("network");
  const hash = (url.searchParams.get("hash") ?? "").trim();
  if (!isCasperNetwork(network)) {
    return NextResponse.json({ error: "network must be 'testnet' or 'mainnet'" }, { status: 400 });
  }
  if (!TX_HASH.test(hash)) {
    return NextResponse.json({ error: "hash must be a 32-byte transaction hash" }, { status: 400 });
  }

  const container = createContainer(network);
  if (!container.chain.checkTransaction) {
    return NextResponse.json({ error: "this chain adapter cannot read transactions" }, { status: 501 });
  }
  const outcome = await container.chain.checkTransaction(hash);
  return NextResponse.json(
    {
      status: outcome.status,
      transactionHash: hash,
      explorerUrl: container.chain.explorerUrlForDeploy(hash),
      error: outcome.status === "reverted" ? outcome.error : undefined,
      network,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
