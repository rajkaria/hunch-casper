import { beforeEach } from "vitest";
import { createMockWallet, __resetMockWallet } from "@/adapters/mock/mock-wallet";
import { runWalletContract } from "./contract/wallet.shared";

// The deterministic mock satisfies the FULL contract: it has a purse it can spend from, so it
// exercises every path including running out of money.
beforeEach(() => {
  __resetMockWallet();
});

runWalletContract("mock", (network) => createMockWallet(network), {
  canTransfer: true,
  agentId: "agent:momentum",
});
