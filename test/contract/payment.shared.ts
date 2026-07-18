/**
 * Shared `PaymentPort` contract test — the x402 rail's invariants, asserted identically against
 * the deterministic mock and the transfer-verifying real adapter.
 *
 * The invariants that matter are the ones an attacker probes: a requirement is bound to a payer
 * and to the bet's parameters, so a proof minted for one bet or one payer cannot settle another.
 * Both adapters must enforce that, and they enforce it in completely different ways (nonce
 * derivation vs on-chain transfer inspection) — which is exactly why the assertion belongs in a
 * shared suite rather than in either adapter's own file.
 *
 * Not named `*.test.ts` — invoked by per-adapter `*.contract.test.ts` files.
 */

import { describe, it, expect } from "vitest";
import type { PaymentPort, X402PaymentProof } from "@/ports/payment";
import type { CasperNetwork } from "@/config/network";

export interface PaymentContractOptions {
  /** Can the server settle on the payer's behalf? (mock: yes; real: no, by design) */
  canSettle: boolean;
  /** Does `verify` reach the network? (real: yes — offline it must fail closed) */
  verifiesOnChain: boolean;
}

const QUOTE = {
  marketId: "testnet:coin-flip-5m",
  outcomeKey: "heads",
  amountMotes: "1000000000",
  payer: "01" + "aa".repeat(32),
};

export function runPaymentContract(
  label: string,
  makePort: (network: CasperNetwork) => PaymentPort,
  opts: PaymentContractOptions,
): void {
  describe(`PaymentPort contract — ${label}`, () => {
    it("quotes a requirement echoing the amount, network and payer", async () => {
      const req = await makePort("testnet").quote(QUOTE);
      expect(req.amountMotes).toBe(QUOTE.amountMotes);
      expect(req.network).toBe("testnet");
      expect(req.payer).toBe(QUOTE.payer);
      expect(req.payTo.length).toBeGreaterThan(0);
      expect(req.nonce.length).toBeGreaterThan(0);
    });

    it("is deterministic: the same bet from the same payer quotes the same nonce", async () => {
      const port = makePort("testnet");
      expect((await port.quote(QUOTE)).nonce).toBe((await port.quote(QUOTE)).nonce);
    });

    it("binds the nonce to the payer — another payer's identical bet quotes differently", async () => {
      const port = makePort("testnet");
      const mine = await port.quote(QUOTE);
      const theirs = await port.quote({ ...QUOTE, payer: "01" + "bb".repeat(32) });
      expect(mine.nonce).not.toBe(theirs.nonce);
    });

    it("binds the nonce to the bet parameters — a different outcome or amount quotes differently", async () => {
      const port = makePort("testnet");
      const base = await port.quote(QUOTE);
      expect((await port.quote({ ...QUOTE, outcomeKey: "tails" })).nonce).not.toBe(base.nonce);
      expect((await port.quote({ ...QUOTE, amountMotes: "2000000000" })).nonce).not.toBe(base.nonce);
    });

    it("rejects a proof carrying the wrong nonce", async () => {
      const port = makePort("testnet");
      const req = await port.quote(QUOTE);
      const forged: X402PaymentProof = {
        scheme: "casper-x402",
        deployHash: "ab".repeat(32),
        nonce: "not-the-nonce",
      };
      expect(await port.verify(req, forged)).toBe(false);
    });

    it("rejects a proof with a foreign scheme", async () => {
      const port = makePort("testnet");
      const req = await port.quote(QUOTE);
      const forged = {
        scheme: "not-casper-x402",
        deployHash: "ab".repeat(32),
        nonce: req.nonce,
      } as unknown as X402PaymentProof;
      expect(await port.verify(req, forged)).toBe(false);
    });

    if (opts.canSettle) {
      it("settles a requirement into a proof that verifies against it", async () => {
        const port = makePort("testnet");
        const req = await port.quote(QUOTE);
        const proof = await port.settle(req, QUOTE.payer);
        expect(proof.scheme).toBe("casper-x402");
        expect(proof.nonce).toBe(req.nonce);
        expect(await port.verify(req, proof)).toBe(true);
      });

      it("does not let one bet's proof settle a different bet", async () => {
        const port = makePort("testnet");
        const mine = await port.quote(QUOTE);
        const other = await port.quote({ ...QUOTE, outcomeKey: "tails" });
        const proof = await port.settle(mine, QUOTE.payer);
        expect(await port.verify(other, proof)).toBe(false);
      });
    } else {
      it("refuses to settle on the payer's behalf — a real agent pays from its own wallet", async () => {
        const port = makePort("testnet");
        const req = await port.quote(QUOTE);
        await expect(port.settle(req, QUOTE.payer)).rejects.toThrow();
      });
    }

    if (opts.verifiesOnChain) {
      it("fails closed when the settlement id is not a transaction hash", async () => {
        const port = makePort("testnet");
        const req = await port.quote(QUOTE);
        // The shape the fleet used to fabricate. Nonce matches; it still must not verify.
        expect(
          await port.verify(req, {
            scheme: "casper-x402",
            deployHash: `x402-settled-${req.nonce}-1`,
            nonce: req.nonce,
          }),
        ).toBe(false);
      });
    }
  });
}
