/**
 * Real x402 PaymentPort — verifies an agent's payment proof against an ACTUAL on-chain CSPR
 * transfer. This is the trustless half of the real-mode agent rail: where the mock adapter
 * accepts any nonce-matching proof, this one fetches the transaction named in
 * `proof.deployHash` from the network's node RPC and checks, on-chain, that
 *
 *   1. the execution SUCCEEDED,
 *   2. the transfer was initiated by the payer the requirement is bound to,
 *   3. it is a native transfer to the operator treasury (`payTo`) of at least `amountMotes`.
 *
 * FETCH-ONLY BY DESIGN. Unlike `real-chain.ts` this adapter never signs anything and carries no
 * `casper-js-sdk` dependency — verification is a JSON-RPC read (`info_get_transaction`, falling
 * back to legacy `info_get_deploy`) plus the pure `verifyTransferResult` below, so the network
 * edge stays thin and the decision logic is offline-testable (same discipline as
 * `chain-signals.ts`). A 5s timeout and an injectable `fetchImpl` keep it test- and
 * outage-friendly; any RPC failure verifies to FALSE — the rail fails closed, never open.
 *
 * `settle()` THROWS on purpose: a real agent pays from its OWN wallet (a CSPR transfer to
 * `payTo`) and presents the transfer hash as its proof. The server never moves money on an
 * external agent's behalf — doing so would turn the operator key into everyone's wallet. This
 * is also why the internal Prophet fleet (which fabricates mock proofs via its own `settle`)
 * cannot bet through this adapter: in real+real-payment mode the fleet must fund genuine
 * transfers or stay on the mock/testnet demo. That is correct, not a bug.
 *
 * Wired by the composition root when `CASPER_CHAIN_MODE=real` AND `CASPER_X402_PAYTO` (the
 * operator treasury account) is set. Server-only; never import from a client component.
 */

import type { CasperNetwork } from "@/config/network";
import { getNetworkConfig } from "@/config/network";
import type {
  PaymentPort,
  QuoteInput,
  X402PaymentProof,
  X402PaymentRequirement,
} from "@/ports/payment";
import { pseudoDeployHash } from "@/adapters/mock/mock-chain";
import { readExecutionOutcome } from "./confirm";
// The verifier lives in the published `x402-casper` surface; this adapter is its RPC plumbing.
import { asRecord, verifyTransferResult } from "@/x402/verify";

export { verifyTransferResult };

const RPC_TIMEOUT_MS = 5_000;

/** A real settlement id is a 32-byte transaction/deploy hash — anything else never hits the RPC. */
const TX_HASH = /^[0-9a-fA-F]{64}$/;

export interface RealPaymentOptions {
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /**
   * How long to keep re-reading a transaction that exists but has not executed yet. An agent that
   * pays and immediately presents its hash is racing block production, and answering "unverifiable"
   * to a transfer that is merely *young* charges the agent for nothing. Bounded, and a timeout
   * still answers false — the rail fails closed.
   */
  pendingRetryMs?: number;
  /** Gap between pending re-reads. */
  pendingIntervalMs?: number;
  /** Injectable sleep + clock so tests do not spend real seconds. */
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
}

/**
 * Default window to let a just-submitted transfer reach a block before calling it unverifiable.
 * Deliberately short: an unknown hash and a young one are indistinguishable from outside, so this
 * window is also how long a bogus hash can hold a request open. Long enough to cross a block,
 * short enough that it is not a lever.
 */
export const DEFAULT_PENDING_RETRY_MS = 20_000;
const DEFAULT_PENDING_INTERVAL_MS = 4_000;

/**
 * The transfer-verifying PaymentPort. `payTo` is the operator treasury account
 * (`CASPER_X402_PAYTO` — a Casper public key hex or `account-hash-…`) every agent payment must
 * land in.
 */
export function createRealPayment(
  network: CasperNetwork,
  payTo: string,
  opts: RealPaymentOptions = {},
): PaymentPort {
  const cfg = getNetworkConfig(network);
  const treasury = payTo.trim();
  const now = opts.nowImpl ?? Date.now;
  const nap = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** POST one JSON-RPC call; returns the parsed `result`-bearing body or null on ANY failure. */
  async function rpc(method: string, params: unknown): Promise<Record<string, unknown> | null> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await fetchImpl(cfg.nodeRpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const body = asRecord(await res.json());
      return body && body.error === undefined && asRecord(body.result) ? body : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async quote(input: QuoteInput): Promise<X402PaymentRequirement> {
      // Same payer-bound nonce discipline as the mock (a proof for one payer/bet can't settle
      // another's) — but the money must land in the operator treasury, verified on-chain.
      const nonce = pseudoDeployHash(
        `nonce:${network}:${input.marketId}:${input.outcomeKey}:${input.amountMotes}:${input.payer}`,
      ).slice(0, 32);
      return { amountMotes: input.amountMotes, payTo: treasury, network, payer: input.payer, nonce };
    },

    async settle(): Promise<X402PaymentProof> {
      throw new Error(
        "real x402 settlement is the agent's job: pay the CSPR transfer from your own wallet to payTo, " +
          "then present the transfer hash as the proof's deployHash — the server never settles on an agent's behalf",
      );
    },

    async verify(requirement: X402PaymentRequirement, proof: X402PaymentProof): Promise<boolean> {
      // Cheap payer/params binding first (same as the mock) — a wrong nonce or a fabricated
      // settlement id (e.g. the fleet's mock proofs) fails closed without touching the network.
      if (proof.scheme !== "casper-x402" || proof.nonce !== requirement.nonce) return false;
      if (typeof proof.deployHash !== "string" || !TX_HASH.test(proof.deployHash)) return false;

      const deadline = now() + (opts.pendingRetryMs ?? DEFAULT_PENDING_RETRY_MS);
      const interval = opts.pendingIntervalMs ?? DEFAULT_PENDING_INTERVAL_MS;

      for (;;) {
        // Casper 2.0 first (native transfers submitted via putTransaction are TransactionV1),
        // then the legacy Deploy lookup for older tooling. Both miss → false.
        const body =
          (await rpc("info_get_transaction", { transaction_hash: { Version1: proof.deployHash } })) ??
          (await rpc("info_get_deploy", { deploy_hash: proof.deployHash }));

        // Unknown to the node, or the node could not be asked. RETRY NOTHING here: a node that
        // accepted a transfer serves it immediately (with a null execution result) while it waits
        // for a block, so "never heard of it" is an answer, not a race. Waiting on it would let
        // any invented hash hold a request open for the whole window.
        if (!body) return false;

        if (verifyTransferResult(body, requirement, proof)) return true;

        // It EXECUTED and does not satisfy the requirement (wrong payer, wrong recipient, too
        // little, reverted). A settled no — retrying cannot change it.
        if (readExecutionOutcome(body).state !== "pending") return false;

        // Seen but not yet executed: the agent paid moments ago and is racing block production.
        // Re-read until the window closes, then fail closed.
        if (now() >= deadline) return false;
        await nap(interval);
      }
    },
  };
}
