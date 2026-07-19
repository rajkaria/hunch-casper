/**
 * Transaction confirmation — the missing half of every real-mode submit.
 *
 * `putTransaction` returns the moment a node ACCEPTS a transaction into its queue, not when the
 * network executes it. Everything downstream of a submit — an x402 proof, an escrowed bet, a
 * resolution — is only true once execution lands in a block. Submitting and returning immediately
 * produced the exact failure this module exists to prevent: a Prophet paid 3 CSPR to the treasury,
 * the payment verifier looked the transaction up microseconds later, found no `execution_info`,
 * correctly refused to verify a not-yet-executed transfer, and the bet was silently dropped. The
 * money moved; nothing was bought.
 *
 * FETCH-ONLY BY DESIGN, like `real-payment.ts`: confirmation is a JSON-RPC read, so it carries no
 * `casper-js-sdk` dependency and the decision logic (`readExecutionOutcome`) is pure and
 * offline-testable. Both the SDK-signing adapters (`real-chain.ts`, `real-wallet.ts`) and the
 * dependency-free payment verifier can share it.
 *
 * FAILS PENDING, NEVER SUCCESS. An unknown transaction, a malformed payload, an RPC outage and a
 * genuinely-unexecuted transaction all read as `pending`. Callers treat a pending timeout as "do
 * not claim this happened" — the safe direction, since claiming an unexecuted bet is the bug.
 */

import type { CasperNetwork } from "@/config/network";
import { getNetworkConfig } from "@/config/network";

/** How long to wait for execution before giving up. Casper testnet blocks land in ~16s. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 150_000;
/** Gap between confirmation polls. */
export const DEFAULT_CONFIRM_INTERVAL_MS = 4_000;
/** Per-request timeout on a single confirmation poll. */
const RPC_TIMEOUT_MS = 5_000;

/**
 * What the chain says about a submitted transaction.
 *
 * `pending` deliberately conflates "not executed yet", "node hasn't seen it", and "we could not
 * ask" — every one of them means the same thing to a caller: you may not act as though this
 * happened yet.
 */
export type ExecutionOutcome =
  | { state: "pending" }
  | { state: "success" }
  | { state: "failure"; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * PURE read of a `info_get_transaction` / `info_get_deploy` body → the execution outcome. Handles
 * the Casper 2.0 shape (`execution_info.execution_result.Version2`) and the legacy deploy shape
 * (`execution_results[0].result.{Success,Failure}`). Anything it cannot read is `pending`.
 */
export function readExecutionOutcome(json: unknown): ExecutionOutcome {
  const root = asRecord(json);
  if (!root || root.error !== undefined) return { state: "pending" };
  const result = asRecord(root.result);
  if (!result) return { state: "pending" };

  // ---- Casper 2.0: execution_info is absent until the transaction is executed in a block.
  const v2 = asRecord(asRecord(asRecord(result.execution_info)?.execution_result)?.Version2);
  if (v2) {
    const err = v2.error_message;
    if (err === null || err === undefined || err === "") return { state: "success" };
    return { state: "failure", error: String(err) };
  }

  // ---- Legacy deploys.
  const legacy = asRecord(
    asRecord(Array.isArray(result.execution_results) ? result.execution_results[0] : null)?.result,
  );
  if (legacy) {
    if (legacy.Success !== undefined) return { state: "success" };
    const failure = asRecord(legacy.Failure);
    if (failure) return { state: "failure", error: String(failure.error_message ?? "execution failed") };
  }

  // A Version1 execution result wrapper with neither marker, or no execution info at all.
  const v1 = asRecord(asRecord(asRecord(result.execution_info)?.execution_result)?.Version1);
  if (v1) {
    const err = v1.error_message;
    if (err === null || err === undefined || err === "") return { state: "success" };
    return { state: "failure", error: String(err) };
  }

  return { state: "pending" };
}

export interface AwaitExecutionOptions {
  /** Injectable fetch (tests, outage simulation). */
  fetchImpl?: typeof fetch;
  /** Injectable sleep so tests do not spend real seconds. */
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  /** Injectable clock; defaults to `Date.now`. */
  nowImpl?: () => number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One JSON-RPC read; null on ANY failure (which the caller reads as `pending`). */
async function rpc(
  nodeRpcUrl: string,
  method: string,
  params: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetchImpl(nodeRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the chain once what happened to `hash`, across both RPC shapes. */
export async function readExecution(
  network: CasperNetwork,
  hash: string,
  opts: AwaitExecutionOptions = {},
): Promise<ExecutionOutcome> {
  const cfg = getNetworkConfig(network);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tx = await rpc(cfg.nodeRpcUrl, "info_get_transaction", { transaction_hash: { Version1: hash } }, fetchImpl);
  const fromTx = readExecutionOutcome(tx);
  if (fromTx.state !== "pending") return fromTx;
  const deploy = await rpc(cfg.nodeRpcUrl, "info_get_deploy", { deploy_hash: hash }, fetchImpl);
  return readExecutionOutcome(deploy);
}

/**
 * Poll until `hash` executes, fails, or the budget runs out. Returns the final outcome — a timeout
 * is reported as `pending`, never as success, so a caller can only ever under-claim.
 */
export async function awaitExecution(
  network: CasperNetwork,
  hash: string,
  opts: AwaitExecutionOptions = {},
): Promise<ExecutionOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_CONFIRM_INTERVAL_MS;
  const now = opts.nowImpl ?? Date.now;
  const nap = opts.sleepImpl ?? sleep;
  const deadline = now() + timeoutMs;

  for (;;) {
    const outcome = await readExecution(network, hash, opts);
    if (outcome.state !== "pending") return outcome;
    if (now() >= deadline) return { state: "pending" };
    await nap(intervalMs);
  }
}
