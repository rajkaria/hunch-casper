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
import type { AgentAccount, TransferInput, TransferResult, WalletPort } from "@/ports/wallet";
import { createMockChain } from "@/adapters/mock/mock-chain";
import { createMockWallet } from "@/adapters/mock/mock-wallet";
import { createMockPayment } from "@/adapters/mock/mock-payment";
import { fleetConfigured } from "@/adapters/casper/fleet-keys";
// Fetch-only (no chain SDK), so a direct import is safe here — unlike `real-chain.ts`, which
// must stay behind the lazy dynamic import below to keep `casper-js-sdk` out of the bundle.
import { createRealPayment } from "@/adapters/casper/real-payment";
import { createMockOracle } from "@/adapters/mock/mock-oracle";
import { createMockLlm } from "@/adapters/mock/mock-llm";
import { createMockMarketStore } from "@/adapters/mock/mock-market-store";

export interface Container {
  network: CasperNetwork;
  chain: CasperChainPort;
  payment: PaymentPort;
  /** Per-agent on-chain identity + purse — how an agent pays its own x402 bill. */
  wallet: WalletPort;
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
function createLazyRealChain(
  network: CasperNetwork,
  marketPackageHash: string | undefined,
  marketAddresses: Record<string, string>,
  vaultV2PackageHash: string | undefined,
): CasperChainPort {
  let cached: Promise<CasperChainPort> | null = null;
  const load = (): Promise<CasperChainPort> =>
    (cached ??= import("@/adapters/casper/real-chain").then((mod) =>
      mod.createRealChain(
        network,
        mod.realChainOptionsFromEnv(marketPackageHash, marketAddresses, vaultV2PackageHash),
      ),
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
 * Lazy real fleet wallet — the same seam as `createLazyRealChain`, for the same reason: the
 * signing SDK must not be pulled in until an agent actually moves money. `accountFor` cannot be
 * served locally (deriving the public key needs Ed25519), so every method loads.
 */
function createLazyRealWallet(network: CasperNetwork): WalletPort {
  let cached: Promise<WalletPort> | null = null;
  const load = (): Promise<WalletPort> =>
    (cached ??= import("@/adapters/casper/real-wallet").then((mod) => mod.createRealWallet(network)));

  return {
    network,
    async accountFor(agentId: string): Promise<AgentAccount> {
      return (await load()).accountFor(agentId);
    },
    async balanceOf(agentId: string): Promise<string> {
      return (await load()).balanceOf(agentId);
    },
    async transfer(input: TransferInput): Promise<TransferResult> {
      return (await load()).transfer(input);
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
      ? createLazyRealChain(network, cfg.contracts.vault, cfg.marketAddresses, cfg.contracts.vaultV2)
      : createMockChain(network);
  // Real mode + a configured treasury (CASPER_X402_PAYTO) upgrades the x402 rail to the
  // transfer-verifying PaymentPort: proofs must map to a real on-chain CSPR transfer to the
  // treasury. Mock mode always keeps the deterministic nonce-match adapter.
  const x402PayTo = process.env.CASPER_X402_PAYTO;
  const payment =
    chainMode() === "real" && x402PayTo
      ? createRealPayment(network, x402PayTo)
      : createMockPayment(network, vaultAddress);
  // The fleet wallet goes real only when real mode ALSO has key material. Real mode without a
  // fleet seed keeps the mock wallet, so the fleet's proofs stay obviously-fake and get rejected
  // by the transfer-verifying PaymentPort — a visible, safe failure. The alternative (a real
  // wallet that throws on every call) would turn a configuration gap into a runtime crash.
  const wallet =
    chainMode() === "real" && fleetConfigured() ? createLazyRealWallet(network) : createMockWallet(network);
  return {
    network,
    chain,
    payment,
    wallet,
    oracle: createMockOracle(),
    llm: createMockLlm(),
    store: createMockMarketStore(),
  };
}
