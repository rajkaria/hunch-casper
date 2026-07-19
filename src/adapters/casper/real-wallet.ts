/**
 * Real Casper `WalletPort` — each agent signs and funds its own native CSPR transfers from a key
 * only it uses. This is what turns a Prophet's x402 payment from a fabricated string into a
 * transaction a stranger can look up on cspr.live and verify against the treasury.
 *
 * SERVER-ONLY BY CONSTRUCTION, like `real-chain.ts`: reached only through the lazy dynamic
 * `import()` in `src/lib/container.ts`, so `casper-js-sdk` never enters the client bundle.
 *
 * Balance reads are a plain JSON-RPC `query_balance` fetch rather than an SDK call — the same
 * discipline as `real-payment.ts` and `chain-signals.ts`. A read that needs no signing should not
 * drag the signing library, a timeout, and a mock-the-SDK test setup along with it; the parse is
 * pure and offline-tested in `fleet-keys.ts`.
 *
 * Custody note: the agent's transfer proves *who paid*. The bet escrow itself is still submitted
 * by the operator key (`real-chain.ts`), so an agent pays exactly once — see the decision journal
 * entry on the two-transaction model.
 */

import {
  AccountHash,
  KeyAlgorithm,
  NativeTransferBuilder,
  PrivateKey,
  PublicKey,
  RpcClient,
  HttpHandler,
  type Transaction,
} from "casper-js-sdk";
import type { CasperNetwork } from "@/config/network";
import {
  explorerTransactionUrl,
  getNetworkConfig,
  NATIVE_TRANSFER_MINIMUM_MOTES,
} from "@/config/network";
import type { AgentAccount, TransferInput, TransferResult, WalletPort } from "@/ports/wallet";
import { agentSecretKey, parseBalanceResult } from "./fleet-keys";
import { awaitExecution, type AwaitExecutionOptions, type ExecutionOutcome } from "./confirm";

const RPC_TIMEOUT_MS = 5_000;

/**
 * Payment limit for a native transfer, in motes. Casper's native transfer is a fixed-cost
 * operation; 0.1 CSPR is the standard limit and leaves the refund model nothing to shave.
 * Overridable for a chainspec that prices transfers differently.
 */
export const TRANSFER_PAYMENT_MOTES = 100_000_000;

export class FleetWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetWalletError";
  }
}

export interface RealWalletOptions {
  /** Injectable fetch for the balance read (tests, outage simulation). */
  fetchImpl?: typeof fetch;
  /** Injectable submit seam so transfer construction is testable without a node. */
  submitImpl?: (tx: Transaction, key: PrivateKey) => Promise<string>;
  /** Payment limit override for the transfer transaction, in motes. */
  transferPaymentMotes?: number;
  /**
   * Injectable confirmation seam. A transfer is not a payment until the chain has executed it, so
   * `transfer` waits — tests stub this rather than spending real seconds against a real node.
   */
  confirmImpl?: (hash: string) => Promise<ExecutionOutcome>;
  /** Tuning/injection for the default confirmation poll. */
  confirmOptions?: AwaitExecutionOptions;
}

/** PEM contents or a 32-byte hex seed → an Ed25519 private key (same shapes `real-chain.ts` accepts). */
function loadKey(pemOrHex: string): PrivateKey {
  const s = pemOrHex.trim();
  return s.includes("BEGIN")
    ? PrivateKey.fromPem(s, KeyAlgorithm.ED25519)
    : PrivateKey.fromHex(s.replace(/^0x/, ""), KeyAlgorithm.ED25519);
}

function keyForAgent(agentId: string): PrivateKey {
  const secret = agentSecretKey(agentId);
  if (!secret) {
    throw new FleetWalletError(
      `no key for agent '${agentId}': set CASPER_FLEET_SEED (the fleet derives one key per agent) ` +
        `or an explicit CASPER_PROPHET_KEY_${agentId.toUpperCase()}`,
    );
  }
  return loadKey(secret);
}

export function createRealWallet(network: CasperNetwork, opts: RealWalletOptions = {}): WalletPort {
  const cfg = getNetworkConfig(network);
  const rpc = new RpcClient(new HttpHandler(cfg.nodeRpcUrl));
  const paymentMotes = opts.transferPaymentMotes ?? TRANSFER_PAYMENT_MOTES;

  async function submit(tx: Transaction, key: PrivateKey): Promise<string> {
    if (opts.submitImpl) return opts.submitImpl(tx, key);
    tx.sign(key);
    const res = await rpc.putTransaction(tx);
    return res.transactionHash.toHex();
  }

  function confirm(hash: string): Promise<ExecutionOutcome> {
    if (opts.confirmImpl) return opts.confirmImpl(hash);
    return awaitExecution(network, hash, { fetchImpl: opts.fetchImpl, ...opts.confirmOptions });
  }

  return {
    network,

    async accountFor(agentId: string): Promise<AgentAccount> {
      const publicKey = keyForAgent(agentId).publicKey;
      return {
        agentId,
        publicKeyHex: publicKey.toHex(),
        accountHash: publicKey.accountHash().toPrefixedString(),
      };
    },

    /**
     * Main-purse balance. An account that has never received funds does not exist on chain, so
     * the RPC errors — that is `"0"`, not a failure: an unfunded agent is exactly what the
     * low-balance path is for. A transport failure is also reported as `"0"` so the caller
     * degrades to "skip this agent's turn" rather than submitting a transfer into the dark.
     */
    async balanceOf(agentId: string): Promise<string> {
      const publicKeyHex = keyForAgent(agentId).publicKey.toHex();
      const fetchImpl = opts.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
      try {
        const res = await fetchImpl(cfg.nodeRpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "query_balance",
            params: { purse_identifier: { main_purse_under_public_key: publicKeyHex } },
          }),
          signal: controller.signal,
        });
        if (!res.ok) return "0";
        return parseBalanceResult(await res.json()) ?? "0";
      } catch {
        return "0";
      } finally {
        clearTimeout(timer);
      }
    },

    async transfer(input: TransferInput): Promise<TransferResult> {
      const amount = BigInt(input.amountMotes);
      if (amount <= 0n) throw new FleetWalletError("transfer amount must be positive");
      // The chainspec floor is a consensus rule: submitting below it burns nothing but returns a
      // raw `-32016 insufficient transfer amount` from the node. Naming the rule and the actual
      // shortfall here is the difference between "this agent's stake is mis-sized" and an opaque
      // RPC code in a cron log.
      if (amount < NATIVE_TRANSFER_MINIMUM_MOTES) {
        throw new FleetWalletError(
          `transfer of ${amount} motes is below the chainspec native-transfer minimum of ` +
            `${NATIVE_TRANSFER_MINIMUM_MOTES} motes (2.5 CSPR) — the node would reject it ` +
            `(-32016 insufficient transfer amount); size the agent's stake above the floor`,
        );
      }
      const key = keyForAgent(input.agentId);

      const builder = new NativeTransferBuilder()
        .from(key.publicKey)
        .amount(input.amountMotes)
        .chainName(cfg.chainName)
        .payment(paymentMotes);

      // A public key and an account-hash are different values (deriving one needs blake2b), so
      // the recipient form decides the builder call rather than being normalised into one shape.
      const to = input.toAccount.trim();
      if (/^account-hash-[0-9a-fA-F]{64}$/.test(to)) {
        builder.targetAccountHash(AccountHash.fromString(to));
      } else {
        builder.target(PublicKey.fromHex(to));
      }

      const hash = await submit(builder.build(), key);

      // Wait for the chain to EXECUTE the transfer before calling it a payment. `putTransaction`
      // only means a node queued it; a hash handed back at that point names a transaction with no
      // execution result, which every verifier — ours included — must refuse. Returning here
      // without waiting is what made a Prophet pay the treasury and receive nothing back.
      const outcome = await confirm(hash);
      if (outcome.state === "failure") {
        throw new FleetWalletError(
          `transfer ${hash} was executed and REVERTED: ${outcome.error} — no payment was made`,
        );
      }
      if (outcome.state === "pending") {
        throw new FleetWalletError(
          `transfer ${hash} did not execute within the confirmation window — it may still land, so ` +
            `do not re-send blind; check ${explorerTransactionUrl(network, hash)} before retrying`,
        );
      }
      return { deployHash: hash, explorerUrl: explorerTransactionUrl(network, hash) };
    },
  };
}
