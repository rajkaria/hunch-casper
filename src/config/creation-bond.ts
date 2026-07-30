/**
 * The creation bond — one number, in one place.
 *
 * The bond is the moderation economics of open market creation: a market that resolves cleanly
 * refunds it, an unresolvable/duplicate/abandoned one forfeits it. Every path that touches it —
 * the vault call that attaches it, the x402 challenge that quotes it, the UI that shows it — must
 * read the SAME number, which is why this module exists rather than a constant per caller. It used
 * to be defined twice (`agent/genesis.ts` and `lib/market-create.ts`); two copies of a money
 * constant are a drift waiting to happen.
 *
 * ## Why the default is 2.5 CSPR and not 1
 *
 * A human pays the bond with a **native CSPR transfer** from their own wallet, and Casper's
 * chainspec floors a native transfer at `NATIVE_TRANSFER_MINIMUM_MOTES` (2.5 CSPR — a consensus
 * rule, not a policy of ours). A 1 CSPR bond is therefore *unpayable*: the node rejects the
 * transfer with `-32016 insufficient transfer amount`, no proof can ever exist, and the creation
 * route answers "invalid or unverifiable creation-bond payment" forever. That was the bug.
 *
 * Raising the default to the floor keeps ONE honest number: the amount transferred, the amount
 * attached to `create_market`, and the amount the vault holds are all the same. The alternative —
 * quote 1, make them send 2.5 — would keep 1.5 CSPR of someone else's money for nothing.
 *
 * The vault only ever checks `attached >= creation_bond`, so attaching more than the deployed
 * vault's configured bond can never revert a call that used to work.
 *
 * ⚠️ WHO GETS THE REFUND. `HunchVault::refund_bond` returns the bond to `config.creator`, which is
 * `env().caller()` at creation — and on the human path `create_market` is submitted by the
 * OPERATOR key, so the refund lands with the operator, not with the visitor whose transfer paid
 * for it. Until creation is wallet-signed end to end (the same move betting already made in
 * `/api/chain/bet/prepare`), the visitor's bond is held, not refundable, and the create page says
 * exactly that rather than promising otherwise.
 */

import { NATIVE_TRANSFER_MINIMUM_MOTES } from "@/config/network";

/**
 * Default creation bond, in motes (2.5 CSPR) — the chainspec's native-transfer floor, for the
 * reason above. Overridable with `CASPER_CREATION_BOND_MOTES`.
 */
export const DEFAULT_CREATION_BOND_MOTES = NATIVE_TRANSFER_MINIMUM_MOTES.toString();

/** The creation bond in motes: the configured override when it is a positive integer, else the default. */
export function creationBondMotes(): string {
  const raw = process.env.CASPER_CREATION_BOND_MOTES;
  return raw && /^\d+$/.test(raw) && BigInt(raw) > 0n ? raw : DEFAULT_CREATION_BOND_MOTES;
}

/**
 * Why the configured bond cannot be paid by a wallet — or `null` when it can.
 *
 * Only an explicit `CASPER_CREATION_BOND_MOTES` below the chainspec floor can trigger this (the
 * default sits exactly on it). Surfaced by the bond-preparation route and `/api/health` so a
 * misconfiguration reads as a named operator error instead of a visitor's payment mysteriously
 * failing to verify — which is precisely how the 1 CSPR default presented itself.
 */
export function creationBondPaymentBlocker(motes: string = creationBondMotes()): string | null {
  if (BigInt(motes) >= NATIVE_TRANSFER_MINIMUM_MOTES) return null;
  return (
    `the configured creation bond (${motes} motes) is below Casper's native-transfer minimum of ` +
    `${NATIVE_TRANSFER_MINIMUM_MOTES} motes (2.5 CSPR), so no wallet can pay it — raise ` +
    `CASPER_CREATION_BOND_MOTES to at least ${NATIVE_TRANSFER_MINIMUM_MOTES} or unset it`
  );
}
