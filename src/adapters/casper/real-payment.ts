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

const RPC_TIMEOUT_MS = 5_000;

/** A real settlement id is a 32-byte transaction/deploy hash — anything else never hits the RPC. */
const TX_HASH = /^[0-9a-fA-F]{64}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Normalize an on-chain account identifier for comparison: lowercase, strip the
 * `account-hash-` / `hash-` / `0x` decorations. A public key and its account-hash remain
 * DIFFERENT values after normalization (deriving one from the other needs blake2b), which is
 * why `verifyTransferResult` compares `payTo` against BOTH the session-arg target (public key
 * form) and the executed transfer records' `to` (account-hash form).
 */
function normalizeAccount(value: string): string {
  return value.trim().toLowerCase().replace(/^(account-hash-|hash-|0x)/, "");
}

function accountsEqual(a: unknown, b: unknown): boolean {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.length > 0 &&
    b.length > 0 &&
    normalizeAccount(a) === normalizeAccount(b)
  );
}

/** Defensive motes parse — a non-negative integer string (or number) → bigint, else null. */
function parseMotes(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Extract named runtime args across the shapes the two RPCs serve: an array of
 * `[name, { parsed }]` pairs (legacy Deploy), `{ Named: [...pairs] }` (TransactionV1 payload
 * fields), or a plain `name → { parsed }` object map. Malformed → empty map.
 */
function extractArgs(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const pairs = Array.isArray(raw) ? raw : (asRecord(raw)?.Named as unknown);
  if (Array.isArray(pairs)) {
    for (const pair of pairs) {
      if (Array.isArray(pair) && typeof pair[0] === "string") {
        out[pair[0]] = asRecord(pair[1])?.parsed;
      }
    }
    return out;
  }
  const map = asRecord(raw);
  if (map && !("Named" in map)) {
    for (const [name, value] of Object.entries(map)) out[name] = asRecord(value)?.parsed;
  }
  return out;
}

/** One place money could have moved to: candidate target identifiers + the amount attached. */
interface TransferCandidate {
  targets: unknown[];
  amountMotes: bigint | null;
}

/** True when a TransactionV1 `fields.target` marks a NATIVE transfer (unit variant or keyed). */
function isNativeTarget(target: unknown): boolean {
  return target === "Native" || asRecord(target)?.Native !== undefined;
}

/** Success check for a Version2 execution result / legacy `Success`-`Failure` wrappers. */
function executionSucceeded(result: Record<string, unknown>): boolean | null {
  const v2 = asRecord(result.Version2);
  if (v2) {
    const err = v2.error_message;
    return err === null || err === undefined || err === "";
  }
  const v1 = asRecord(result.Version1) ?? result;
  if (asRecord(v1)?.Success !== undefined) return true;
  if (asRecord(v1)?.Failure !== undefined) return false;
  return null; // shape unknown → caller treats as unverifiable
}

/**
 * PURE verification of a node-RPC transaction lookup against an x402 requirement. Handles both
 * the Casper 2.0 `info_get_transaction` shape (TransactionV1 + `execution_info` with a
 * `Version2` execution result) and the legacy `info_get_deploy` shape (Deploy +
 * `execution_results[0]`). Defensive throughout: any malformed / partial / pending payload
 * verifies to false, never throws.
 */
export function verifyTransferResult(
  json: unknown,
  requirement: X402PaymentRequirement,
  proof: X402PaymentProof,
): boolean {
  try {
    const root = asRecord(json);
    if (!root || root.error !== undefined) return false;
    const result = asRecord(root.result);
    if (!result) return false;

    // ---- Locate the transaction body across the two shapes.
    const txWrapper = asRecord(result.transaction);
    const txV1 = asRecord(txWrapper?.Version1);
    const legacyDeploy = asRecord(txWrapper?.Deploy) ?? asRecord(result.deploy);
    if (!txV1 && !legacyDeploy) return false;

    // ---- Cross-check the RPC echoed the settlement hash the proof named (when present).
    const echoedHash = txV1?.hash ?? legacyDeploy?.hash;
    if (typeof echoedHash === "string" && echoedHash.toLowerCase() !== proof.deployHash.toLowerCase()) {
      return false;
    }

    // ---- (a) Execution succeeded.
    const executionInfo = asRecord(result.execution_info);
    const v2Result = asRecord(executionInfo?.execution_result);
    const legacyResults = Array.isArray(result.execution_results) ? result.execution_results : null;
    const legacyResult = asRecord(asRecord(legacyResults?.[0])?.result);
    const execution = v2Result ?? legacyResult;
    if (!execution) return false; // pending / unexecuted → unverifiable → false
    if (executionSucceeded(execution) !== true) return false;

    // ---- (b) The initiator/account is the payer this requirement is bound to.
    const payload = asRecord(txV1?.payload);
    const initiator =
      asRecord(payload?.initiator_addr)?.PublicKey ??
      asRecord(payload?.initiator_addr)?.AccountHash ??
      asRecord(legacyDeploy?.header)?.account;
    if (!accountsEqual(initiator, requirement.payer)) return false;

    // ---- (c) A native transfer to payTo of at least amountMotes.
    const required = parseMotes(requirement.amountMotes);
    if (required === null) return false;

    const candidates: TransferCandidate[] = [];

    // Session/transaction args — only when the shape marks a NATIVE transfer (a contract call
    // could also carry `target`/`amount` args and must not pass as a payment).
    const fields = asRecord(payload?.fields);
    if (fields && isNativeTarget(fields.target)) {
      const args = extractArgs(fields.args);
      candidates.push({ targets: [args.target], amountMotes: parseMotes(args.amount) });
    }
    const transferSession = asRecord(asRecord(legacyDeploy?.session)?.Transfer);
    if (transferSession) {
      const args = extractArgs(transferSession.args);
      candidates.push({ targets: [args.target], amountMotes: parseMotes(args.amount) });
    }

    // Executed transfer records (Version2 execution results carry full records). `to` is the
    // recipient account-hash; `target` a purse uref — scan both so an account-hash payTo matches.
    const transfers = asRecord(execution.Version2)?.transfers ?? executionInfo?.transfers;
    if (Array.isArray(transfers)) {
      for (const t of transfers) {
        const record = asRecord(t);
        if (!record) continue;
        candidates.push({ targets: [record.to, record.target], amountMotes: parseMotes(record.amount) });
      }
    }

    return candidates.some(
      (c) =>
        c.amountMotes !== null &&
        c.amountMotes >= required &&
        c.targets.some((t) => accountsEqual(t, requirement.payTo)),
    );
  } catch {
    return false;
  }
}

export interface RealPaymentOptions {
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

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

      // Casper 2.0 first (native transfers submitted via putTransaction are TransactionV1),
      // then the legacy Deploy lookup for older tooling. Both miss → false.
      const tx = await rpc("info_get_transaction", { transaction_hash: { Version1: proof.deployHash } });
      if (tx) return verifyTransferResult(tx, requirement, proof);
      const deploy = await rpc("info_get_deploy", { deploy_hash: proof.deployHash });
      if (deploy) return verifyTransferResult(deploy, requirement, proof);
      return false;
    },
  };
}
