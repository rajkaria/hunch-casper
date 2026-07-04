/**
 * Deterministic, credential-free CasperChainPort. Produces stable pseudo deploy hashes so
 * tests and demos are reproducible. The real Casper/Odra adapter (S1–S2) implements the same
 * interface and is checked against the same contract tests.
 */

import type { CasperNetwork } from "@/config/network";
import { explorerDeployUrl } from "@/config/network";
import type {
  CasperChainPort,
  DeployResult,
  PlaceBetInput,
  ResolveMarketInput,
} from "@/ports/casper-chain";

/** FNV-1a → expanded to a 64-hex-char string. Deterministic; no randomness. */
export function pseudoDeployHash(seed: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let out = "";
  let x = h >>> 0;
  while (out.length < 64) {
    x = Math.imul(x ^ (x >>> 15), 2246822519) >>> 0;
    out += (x >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

export function createMockChain(network: CasperNetwork): CasperChainPort {
  let height = 3_400_000;
  return {
    network,
    async getBlockHeight() {
      height += 1;
      return height;
    },
    async placeBet(input: PlaceBetInput): Promise<DeployResult> {
      const hash = pseudoDeployHash(
        `bet:${network}:${input.marketId}:${input.outcomeKey}:${input.amountMotes}:${input.bettor}`,
      );
      return { deployHash: hash, explorerUrl: explorerDeployUrl(network, hash) };
    },
    async resolveMarket(input: ResolveMarketInput): Promise<DeployResult> {
      const hash = pseudoDeployHash(
        `resolve:${network}:${input.marketId}:${input.winningOutcomeKey}:${input.oracleId}`,
      );
      return { deployHash: hash, explorerUrl: explorerDeployUrl(network, hash) };
    },
    explorerUrlForDeploy(deployHash: string) {
      return explorerDeployUrl(network, deployHash);
    },
  };
}
