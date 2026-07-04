/**
 * Shared CasperChainPort contract test. Any adapter that claims to be a `CasperChainPort` —
 * the deterministic mock today, the real `casper-js-sdk` adapter next — must satisfy these
 * invariants. This is the "same contract tests, zero core refactor" guarantee from the
 * architecture: the mock runs the full suite (it can submit), the real adapter runs the
 * credential-free subset (network + explorer-URL shape) because a live submit needs a funded
 * key that CI does not hold.
 *
 * This file is intentionally NOT named `*.test.ts` — it exports a suite factory that the
 * per-adapter `*.contract.test.ts` files invoke, so vitest runs it once per adapter.
 */

import { describe, it, expect } from "vitest";
import type { CasperChainPort } from "@/ports/casper-chain";
import type { CasperNetwork } from "@/config/network";

export interface ChainContractOptions {
  /** Can `placeBet` / `resolveMarket` actually be invoked here? (mock: yes; real w/o creds: no) */
  canSubmit: boolean;
  /** Do identical inputs yield an identical deploy hash? (mock: yes; real: no) */
  deterministic: boolean;
}

export function runCasperChainContract(
  label: string,
  makePort: (network: CasperNetwork) => CasperChainPort,
  opts: ChainContractOptions,
): void {
  describe(`CasperChainPort contract — ${label}`, () => {
    it("reports the network it was constructed for", () => {
      expect(makePort("testnet").network).toBe("testnet");
      expect(makePort("mainnet").network).toBe("mainnet");
    });

    it("builds an explorer URL on the correct network + Casper-2.0 /transaction/ path", () => {
      const onTest = makePort("testnet").explorerUrlForDeploy("deadbeef");
      expect(onTest).toBe("https://testnet.cspr.live/transaction/deadbeef");

      const onMain = makePort("mainnet").explorerUrlForDeploy("deadbeef");
      expect(onMain).toBe("https://cspr.live/transaction/deadbeef");
    });

    if (opts.canSubmit) {
      it("places a bet, returning a non-empty hash whose explorer URL embeds it", async () => {
        const port = makePort("testnet");
        const res = await port.placeBet({
          marketId: "testnet:coin-flip-5m",
          outcomeKey: "heads",
          amountMotes: "1000000000",
          bettor: "agent:momentum",
        });
        expect(res.deployHash.length).toBeGreaterThan(0);
        expect(res.explorerUrl).toContain(res.deployHash);
        expect(res.explorerUrl).toContain("testnet.cspr.live");
      });

      it("resolves a market, returning a non-empty hash", async () => {
        const port = makePort("testnet");
        const res = await port.resolveMarket({
          marketId: "testnet:coin-flip-5m",
          winningOutcomeKey: "tails",
          oracleId: "arbiter",
        });
        expect(res.deployHash.length).toBeGreaterThan(0);
        expect(res.explorerUrl).toContain(res.deployHash);
      });

      it("exposes a monotonic-ish block height as a liveness probe", async () => {
        const port = makePort("testnet");
        const h = await port.getBlockHeight();
        expect(typeof h).toBe("number");
        expect(h).toBeGreaterThan(0);
      });

      if (opts.deterministic) {
        it("is deterministic: identical bet inputs yield an identical hash", async () => {
          const input = {
            marketId: "testnet:m",
            outcomeKey: "yes",
            amountMotes: "5",
            bettor: "agent:value",
          };
          const a = await makePort("testnet").placeBet(input);
          const b = await makePort("testnet").placeBet(input);
          expect(a.deployHash).toBe(b.deployHash);
        });

        it("is deterministic: different bettors yield different hashes", async () => {
          const base = { marketId: "m", outcomeKey: "yes", amountMotes: "5" };
          const a = await makePort("testnet").placeBet({ ...base, bettor: "agent:value" });
          const b = await makePort("testnet").placeBet({ ...base, bettor: "agent:chaos" });
          expect(a.deployHash).not.toBe(b.deployHash);
        });
      }
    }
  });
}
