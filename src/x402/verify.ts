/**
 * The verifier — a pure function from a Casper node-RPC transaction lookup to "did this payer
 * really pay this much to this account?".
 *
 * Pure and dependency-free on purpose. It touches no network, no key, and no framework, so the
 * same code runs in a Next route handler, an edge function, a keeper, or a test with a recorded
 * fixture — and so a reimplementation in another language can be checked against it directly.
 *
 * It reads BOTH RPC shapes a Casper node can serve: the 2.0 `info_get_transaction` response
 * (TransactionV1 with a `Version2` execution result) and the legacy `info_get_deploy` one
 * (Deploy with `execution_results[0]`). A payload it cannot fully understand verifies to `false`.
 * Every branch fails closed: malformed, pending, partial and unreadable all mean "not paid",
 * because the alternative — treating "I could not tell" as settled — is how a paywall leaks.
 *
 * Four things must hold at once, and each has a reason:
 *
 *   (a) the transaction EXECUTED successfully — a queued or reverted transfer moved nothing;
 *   (b) its initiator IS the requirement's payer — otherwise any observed hash on chain would be
 *       a bearer token anyone could present as their own payment;
 *   (c) it moved at least `amountMotes`;
 *   (d) it landed on `payTo`.
 *
 * (b) is the one most implementations miss, and it is the one that matters most.
 */

// Relative imports only — this module ships in the `x402-casper` package, whose consumers do not
// have this repo's tsconfig path aliases.
import type { X402PaymentProof, X402PaymentRequirement } from "../ports/payment";

export function asRecord(value: unknown): Record<string, unknown> | null {
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
