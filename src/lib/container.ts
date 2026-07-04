/**
 * Composition root — the ONLY place that picks adapters. Everything else receives a
 * `Container` and depends on ports, never on concrete adapters. Today it wires the mock
 * adapters; S1–S2 swap the chain/payment/oracle adapters for real Casper ones here, with no
 * change to core or UI.
 */

import type { CasperNetwork } from "@/config/network";
import { DEFAULT_NETWORK, getNetworkConfig } from "@/config/network";
import type {
  CasperChainPort,
  LlmClient,
  MarketStorePort,
  OraclePort,
  PaymentPort,
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

export function createContainer(network: CasperNetwork = DEFAULT_NETWORK): Container {
  const cfg = getNetworkConfig(network);
  const vaultAddress = cfg.contracts.vault ?? "vault-mock-account";
  return {
    network,
    chain: createMockChain(network),
    payment: createMockPayment(network, vaultAddress),
    oracle: createMockOracle(),
    llm: createMockLlm(),
    store: createMockMarketStore(),
  };
}
