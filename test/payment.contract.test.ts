/**
 * Both PaymentPort adapters against the same contract suite.
 *
 * The mock settles on the payer's behalf and verifies by nonce match. The real adapter refuses to
 * settle (a real agent pays from its own wallet) and verifies against an actual on-chain
 * transfer — offline, with no node reachable, it must therefore fail closed on every proof. Both
 * still owe the same binding guarantees, which is what this asserts.
 */

import { createMockPayment } from "@/adapters/mock/mock-payment";
import { createRealPayment } from "@/adapters/casper/real-payment";
import { runPaymentContract } from "./contract/payment.shared";

runPaymentContract("mock", (network) => createMockPayment(network, "vault-mock-account"), {
  canSettle: true,
  verifiesOnChain: false,
});

runPaymentContract(
  "real",
  (network) =>
    createRealPayment(network, "01" + "ff".repeat(32), {
      // No node in CI: every RPC read fails, and the rail must fail closed rather than open.
      fetchImpl: (async () => {
        throw new Error("no node in CI");
      }) as unknown as typeof fetch,
    }),
  { canSettle: false, verifiesOnChain: true },
);
