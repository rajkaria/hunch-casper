import { createMockChain } from "@/adapters/mock/mock-chain";
import { runCasperChainContract } from "./contract/casper-chain.shared";

// The deterministic mock satisfies the FULL contract: it can submit (no chain needed) and is
// reproducible by construction.
runCasperChainContract("mock", (network) => createMockChain(network), {
  canSubmit: true,
  deterministic: true,
});
