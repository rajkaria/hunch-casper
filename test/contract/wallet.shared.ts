/**
 * Shared `WalletPort` contract test. Anything that claims to be an agent wallet — the
 * deterministic mock today, the Ed25519 fleet wallet next — must satisfy these invariants.
 *
 * The load-bearing one is **identity stability**: fleet wallets are funded by hand, so an
 * `accountFor` that returned a different account after a restart would strand real money at an
 * address nothing signs for any more. It is asserted across independently-constructed ports, not
 * just twice on the same instance, because a per-instance cache would hide exactly that bug.
 *
 * Not named `*.test.ts` — it exports a suite factory that per-adapter `*.contract.test.ts` files
 * invoke, so vitest runs it once per adapter.
 */

import { describe, it, expect } from "vitest";
import type { WalletPort } from "@/ports/wallet";
import type { CasperNetwork } from "@/config/network";

export interface WalletContractOptions {
  /** Can `transfer` actually be invoked? (mock: yes; real without a funded key: no) */
  canTransfer: boolean;
  /** An agent id this adapter can resolve an account for. */
  agentId: string;
}

export function runWalletContract(
  label: string,
  makePort: (network: CasperNetwork) => WalletPort,
  opts: WalletContractOptions,
): void {
  describe(`WalletPort contract — ${label}`, () => {
    it("reports the network it was constructed for", () => {
      expect(makePort("testnet").network).toBe("testnet");
      expect(makePort("mainnet").network).toBe("mainnet");
    });

    it("resolves a stable account for an agent across independently constructed ports", async () => {
      const first = await makePort("testnet").accountFor(opts.agentId);
      const second = await makePort("testnet").accountFor(opts.agentId);
      expect(first.publicKeyHex).toBe(second.publicKeyHex);
      expect(first.agentId).toBe(opts.agentId);
      expect(first.publicKeyHex.length).toBeGreaterThan(0);
    });

    it("gives different agents different accounts", async () => {
      const port = makePort("testnet");
      const a = await port.accountFor("agent:alpha");
      const b = await port.accountFor("agent:beta");
      expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
    });

    it("reports a balance as a non-negative motes string", async () => {
      const balance = await makePort("testnet").balanceOf(opts.agentId);
      expect(balance).toMatch(/^\d+$/);
      expect(BigInt(balance) >= 0n).toBe(true);
    });

    if (opts.canTransfer) {
      it("transfers, returning a hash whose explorer URL embeds it", async () => {
        const port = makePort("testnet");
        const res = await port.transfer({
          agentId: opts.agentId,
          toAccount: "01" + "ab".repeat(32),
          amountMotes: "1000000000",
        });
        expect(res.deployHash.length).toBeGreaterThan(0);
        expect(res.explorerUrl).toContain(res.deployHash);
      });

      it("debits the purse by exactly the amount transferred", async () => {
        const port = makePort("testnet");
        const before = BigInt(await port.balanceOf(opts.agentId));
        await port.transfer({
          agentId: opts.agentId,
          toAccount: "01" + "ab".repeat(32),
          amountMotes: "1000000000",
        });
        const after = BigInt(await port.balanceOf(opts.agentId));
        expect(before - after).toBe(1_000_000_000n);
      });

      it("issues a distinct settlement id for two identical transfers", async () => {
        const port = makePort("testnet");
        const input = { agentId: opts.agentId, toAccount: "01" + "cd".repeat(32), amountMotes: "1000000000" };
        const first = await port.transfer(input);
        const second = await port.transfer(input);
        expect(first.deployHash).not.toBe(second.deployHash);
      });

      it("refuses a non-positive amount", async () => {
        await expect(
          makePort("testnet").transfer({ agentId: opts.agentId, toAccount: "01ab", amountMotes: "0" }),
        ).rejects.toThrow();
      });

      it("refuses to spend more than the purse holds, rather than submitting a doomed transfer", async () => {
        const port = makePort("testnet");
        const balance = await port.balanceOf(opts.agentId);
        await expect(
          port.transfer({
            agentId: opts.agentId,
            toAccount: "01ab",
            amountMotes: (BigInt(balance) + 1n).toString(),
          }),
        ).rejects.toThrow(/insufficient/i);
      });
    }
  });
}
