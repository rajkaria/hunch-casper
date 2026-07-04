/**
 * Pure Casper call-plan builder — the ABI seam between the app's ports and the on-chain
 * Odra contracts. This module has **no SDK dependency**: it turns a `PlaceBetInput` /
 * `ResolveMarketInput` into a normalized {@link CasperCallPlan} describing exactly which
 * entry point to call, with which runtime args, how much CSPR to attach, and how much gas to
 * budget. The `casper-js-sdk`-backed adapter (`real-chain.ts`) then serializes, signs, and
 * submits that plan.
 *
 * Keeping the mapping pure is what makes the real adapter testable offline: the plan is the
 * part that MUST match the deployed Odra ABI, and it can be asserted in CI without a funded
 * key or a live node. See `test/deploy-plan.test.ts`.
 *
 * ABI (from `contracts/src/parimutuel_market.rs`):
 *   - `#[odra(payable)] bet(outcome: String)`   → entry point "bet",    arg `outcome`,        attach the stake.
 *   - `resolve(winning_outcome: String)`        → entry point "resolve", arg `winning_outcome`, no value.
 *
 * PAYABLE MECHANISM (Odra 2.8.2, verified against the framework source): a payable entry
 * point does NOT receive its CSPR from a direct package call — Odra routes the value through
 * its `proxy_caller_with_return.wasm` session, which mints a one-time cargo purse from the
 * signer and injects it so `self.env().attached_value()` reads the stake. A direct call would
 * attach ZERO value (a silent money bug). The pure plan therefore carries a `usesProxy` flag:
 * the SDK-backed adapter wraps a `usesProxy` plan's logical call in that proxy envelope, and
 * sends a non-proxy plan as a direct package-targeting transaction. Keeping the flag here
 * makes "payable ⇒ proxy" an offline-asserted invariant rather than a runtime discovery.
 *
 * INVARIANT: the `outcome` string sent on-chain must equal the market's on-chain outcome key
 * exactly (the Odra contract rejects unknown outcomes). Callers pass the catalogue outcome
 * key through verbatim; a market's on-chain `outcomes` must therefore mirror its catalogue
 * `outcome.key`s. See `PlaceBetInput.outcomeKey`.
 */

import type { PlaceBetInput, ResolveMarketInput } from "@/ports/casper-chain";

/** 1 CSPR = 1e9 motes. */
const MOTES_PER_CSPR = 1_000_000_000n;

/**
 * Default gas budgets (in motes). A payable Odra `bet` routes value through a proxy-caller
 * session, so it is budgeted higher than the plain `resolve` call. Both are overridable per
 * call via {@link BuildPlanOptions.gasMotes} — these are safe upper-bound defaults, not
 * measured minima.
 */
export const DEFAULT_BET_GAS_MOTES = (10n * MOTES_PER_CSPR).toString();
export const DEFAULT_RESOLVE_GAS_MOTES = (5n * MOTES_PER_CSPR).toString();

/** A single runtime argument. Odra passes String entry-point args 1:1 under their Rust name. */
export interface CasperCallArg {
  name: string;
  /** CLType of the value. Only the subset the Hunch contracts use. */
  clType: "string" | "u512";
  /** String-encoded value (decimal for u512; raw for string) — keeps the plan JSON/bigint-safe. */
  value: string;
}

/**
 * A network-, key-, and SDK-agnostic description of one on-chain contract call. Everything
 * `real-chain.ts` needs to build a signed transaction, and nothing it doesn't. `args` are the
 * ENTRY POINT's own args (e.g. `outcome`); when `usesProxy` is set the adapter serializes
 * them into the proxy envelope rather than sending them directly.
 */
export interface CasperCallPlan {
  /** Target contract — the market's `ParimutuelMarket` **package** hash (`hash-<64hex>`). */
  targetContract: string;
  /** Odra entry-point name, called verbatim on the deployed contract. */
  entryPoint: string;
  /** Ordered entry-point runtime args. */
  args: CasperCallArg[];
  /** CSPR attached to a payable call, in motes. "0" when the entry point is not payable. */
  attachedMotes: string;
  /** Gas/payment budget, in motes. */
  gasMotes: string;
  /**
   * Whether this call must be sent through Odra's `proxy_caller_with_return.wasm` session to
   * carry attached CSPR (true for payable `bet`; false for the direct, non-payable `resolve`).
   */
  usesProxy: boolean;
}

export interface BuildPlanOptions {
  /**
   * The `ParimutuelMarket` contract this market lives at. In the single-sample S1/S2 wiring
   * this is `NetworkConfig.contracts.vault`; once the registry drives many markets it is the
   * per-market address resolved from `MarketFactory`.
   */
  marketContract: string;
  /** Override the default gas budget (motes). */
  gasMotes?: string;
}

const DECIMAL = /^\d+$/;

function assertPositiveMotes(label: string, motes: string): void {
  if (!DECIMAL.test(motes)) {
    throw new Error(`${label} must be a non-negative integer motes string, got: ${JSON.stringify(motes)}`);
  }
  if (BigInt(motes) <= 0n) {
    throw new Error(`${label} must be greater than zero, got: ${motes}`);
  }
}

function assertNonEmpty(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

/** Build the plan for escrowing a stake onto an outcome (payable `bet`). */
export function buildBetPlan(input: PlaceBetInput, opts: BuildPlanOptions): CasperCallPlan {
  assertNonEmpty("marketContract", opts.marketContract);
  assertNonEmpty("outcomeKey", input.outcomeKey);
  assertPositiveMotes("amountMotes", input.amountMotes);
  return {
    targetContract: opts.marketContract,
    entryPoint: "bet",
    args: [{ name: "outcome", clType: "string", value: input.outcomeKey }],
    attachedMotes: input.amountMotes,
    gasMotes: opts.gasMotes ?? DEFAULT_BET_GAS_MOTES,
    usesProxy: true, // payable → routed through proxy_caller_with_return.wasm
  };
}

/** Build the plan for the oracle's `resolve` to a winning outcome (non-payable). */
export function buildResolvePlan(input: ResolveMarketInput, opts: BuildPlanOptions): CasperCallPlan {
  assertNonEmpty("marketContract", opts.marketContract);
  assertNonEmpty("winningOutcomeKey", input.winningOutcomeKey);
  return {
    targetContract: opts.marketContract,
    entryPoint: "resolve",
    args: [{ name: "winning_outcome", clType: "string", value: input.winningOutcomeKey }],
    attachedMotes: "0",
    gasMotes: opts.gasMotes ?? DEFAULT_RESOLVE_GAS_MOTES,
    usesProxy: false, // non-payable → direct package-targeting transaction
  };
}
