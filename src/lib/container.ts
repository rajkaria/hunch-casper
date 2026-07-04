/**
 * Composition root — the ONLY place that picks adapters. Everything else receives a
 * `Container` and depends on ports, never on concrete adapters. Today it wires the mock
 * adapters; S1–S2 swap the chain/payment/oracle adapters for real Casper ones here, with no
 * change to core or UI.
 */

import type { CasperNetwork } from "@/config/network";
import { DEFAULT_NETWORK, explorerTransactionUrl, getNetworkConfig } from "@/config/network";
import { chainMode } from "@/config/chain-mode";
import type {
  CasperChainPort,
  DeployResult,
  LlmClient,
  MarketStorePort,
  OraclePort,
  PaymentPort,
  PlaceBetInput,
  ResolveMarketInput,
} from "@/ports";
import { createMockChain } from "@/adapters/mock/mock-chain";
import { createMockPayment } from "@/adapters/mock/mock-payment";
import { createMockOracle } from "@/adapters/mock/mock-oracle";
import { createMockLlm } from "@/adapters/mock/mock-llm";
import { createMockMarketStore } from "@/adapters/mock/mock-market-store";

export interface Container {
  network: CasperNetwork;
  chain: CasperChainPort;
  payment: PaymentPort;
  oracle: OraclePort;
  llm: LlmClient;
  store: MarketStorePort;
}

/**
 * Lazy real Casper adapter. The `casper-js-sdk`-backed `real-chain.ts` (and thus the heavy
 * chain SDK) is loaded via a dynamic `import()` on the FIRST chain call, never at module load,
 * so it stays out of the client bundle even if `createContainer` is imported somewhere it
 * shouldn't be — the same seam the Sui rail uses in the main Hunch app. Sync methods that need
 * no chain (`explorerUrlForDeploy`) are served locally so the loader is only paid when a real
 * transaction is actually submitted.
 */
function createLazyRealChain(network: CasperNetwork, marketPackageHash: string | undefined): CasperChainPort {
  let cached: Promise<CasperChainPort> | null = null;
  const load = (): Promise<CasperChainPort> =>
    (cached ??= import("@/adapters/casper/real-chain").then((mod) =>
      mod.createRealChain(network, mod.realChainOptionsFromEnv(marketPackageHash)),
    ));

  return {
    network,
    async getBlockHeight(): Promise<number> {
      return (await load()).getBlockHeight();
    },
    async placeBet(input: PlaceBetInput): Promise<DeployResult> {
      return (await load()).placeBet(input);
    },
    async resolveMarket(input: ResolveMarketInput): Promise<DeployResult> {
      return (await load()).resolveMarket(input);
    },
    explorerUrlForDeploy(deployHash: string): string {
      return explorerTransactionUrl(network, deployHash);
    },
  };
}

/**
 * Compose the app's adapters for a network. The mock adapters are the default so CI, local
 * dev, and the deployed demo run credential-free; setting `CASPER_CHAIN_MODE=real` swaps the
 * chain adapter for the live Casper one (which validates its own keys/addresses on first use).
 * Everything else stays mock until its real adapter lands in a later sprint.
 */
export function createContainer(network: CasperNetwork = DEFAULT_NETWORK): Container {
  const cfg = getNetworkConfig(network);
  const vaultAddress = cfg.contracts.vault ?? "vault-mock-account";
  const chain =
    chainMode() === "real"
      ? createLazyRealChain(network, cfg.contracts.vault)
      : createMockChain(network);
  return {
    network,
    chain,
    payment: createMockPayment(network, vaultAddress),
    oracle: createMockOracle(),
    llm: createMockLlm(),
    store: createMockMarketStore(),
  };
}
