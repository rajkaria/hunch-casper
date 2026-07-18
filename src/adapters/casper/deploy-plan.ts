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

import type { CreateMarketInput, PlaceBetInput, ResolveMarketInput } from "@/ports/casper-chain";

/** 1 CSPR = 1e9 motes. */
const MOTES_PER_CSPR = 1_000_000_000n;

/**
 * Default gas budgets (in motes), matched to CHAIN MEASUREMENTS — see the table at the top of
 * `contracts/bin/catalogue.rs`, and keep the two in step: the app and the deploy driver must never
 * price the same call differently.
 *
 * These were previously round guesses (bet 10, resolve 5) described as "safe upper bounds". They
 * were not: `resolve` consumes **6.317 CSPR**, so a 5 CSPR limit ran every real-mode resolution out
 * of gas — and an out-of-gas transaction refunds nothing, so each failure burned the whole limit
 * while settling nobody. Meanwhile `bet` at 10 was over-budgeted, and testnet's 75 % refund model
 * means 25 % of the unused slack is burned on every call.
 *
 * Sized at ~2–3.5x measured consumption: enough headroom for a heavier-than-usual execution,
 * little enough that the refund model is not quietly taxing every transaction.
 */
/** `bet` measured 1.439 consumed → limit 5 is ~3.5x, netting ~2.33 CSPR. */
export const DEFAULT_BET_GAS_MOTES = (5n * MOTES_PER_CSPR).toString();
/** `resolve` measured 6.317 consumed → limit 12 is ~1.9x, netting ~7.74 CSPR. */
export const DEFAULT_RESOLVE_GAS_MOTES = (12n * MOTES_PER_CSPR).toString();
/**
 * `create_market` measured 2.323 CSPR consumed on a warm vault and 4.958 on the very first call
 * (which initialises the vault's dictionaries). 8 covers the spike at ~1.6x and a typical call at
 * ~3.4x — the same limit `contracts/bin/catalogue.rs` uses, kept in step deliberately so the app
 * and the deploy driver are never priced differently for the same call.
 */
export const DEFAULT_CREATE_GAS_MOTES = (8n * MOTES_PER_CSPR).toString();

/**
 * A single runtime argument. Odra passes entry-point args 1:1 under their Rust name.
 *
 * A discriminated union rather than one `{clType, value}` shape, because `create_market` takes a
 * `Vec<String>` and an `Address`: encoding a list into a delimited string would put an escaping
 * bug directly in the money path's ABI. Scalars stay string-encoded so a plan is JSON- and
 * bigint-safe and can be asserted offline.
 */
export type CasperCallArg =
  | { name: string; clType: "string"; value: string }
  /** Decimal-encoded integers. `u512` for motes, `u32`/`u64` for contract-side numerics. */
  | { name: string; clType: "u512" | "u32" | "u64"; value: string }
  /** An Odra `Address` — `account-hash-<64hex>` (an account) or `hash-<64hex>` (a contract). */
  | { name: string; clType: "key"; value: string }
  /** `Vec<String>` — outcome keys, verbatim. */
  | { name: string; clType: "string-list"; values: string[] };

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
   * The contract this market's call targets — a per-market `ParimutuelMarket` package
   * (legacy v1) or the singleton `HunchVault` v2 package.
   */
  marketContract: string;
  /**
   * Set when `marketContract` is the v2 singleton vault: the market's id inside the vault
   * (the catalogue slug). The plan then carries a leading `market_id` runtime arg, matching
   * the v2 ABI `bet(market_id, outcome)` / `resolve(market_id, winning_outcome)`.
   */
  vaultMarketId?: string;
  /** Override the default gas budget (motes). */
  gasMotes?: string;
}

/**
 * Where a market's on-chain calls go: a contract package plus — when that package is the
 * v2 singleton vault — the market's id inside it.
 */
export interface MarketCallTarget {
  /** Target contract package hash (`hash-<64hex>`). */
  contract: string;
  /** The vault market key (catalogue slug); only set for v2 vault routing. */
  vaultMarketId?: string;
}

/**
 * Resolve which deployed contract a market lives at, v1 and v2 aware. Routing order —
 * pure + offline-tested, because a mis-routed bet is a money bug:
 *
 *   1. `marketAddresses` (`NEXT_PUBLIC_*_MARKET_ADDRS`) — the five legacy per-market
 *      `ParimutuelMarket` packages deployed before S16 stay routable exactly as before.
 *   2. `vaultV2` (`NEXT_PUBLIC_*_VAULT_V2`) — every other slug is a state entry in the
 *      singleton `HunchVault`; calls carry the slug as `market_id`.
 *   3. `fallback` (`NEXT_PUBLIC_*_VAULT`) — the legacy single-contract thin-slice deploy.
 */
export function resolveMarketTarget(
  marketId: string,
  opts: { marketAddresses?: Record<string, string>; vaultV2?: string; fallback?: string },
): MarketCallTarget {
  const colon = marketId.indexOf(":");
  const slug = colon >= 0 ? marketId.slice(colon + 1) : marketId;
  const legacy = opts.marketAddresses?.[slug];
  if (legacy) {
    return { contract: legacy };
  }
  if (opts.vaultV2) {
    return { contract: opts.vaultV2, vaultMarketId: slug };
  }
  if (opts.fallback) {
    return { contract: opts.fallback };
  }
  throw new Error(
    `no on-chain contract for market '${marketId}' — add it to NEXT_PUBLIC_*_MARKET_ADDRS or set NEXT_PUBLIC_*_VAULT_V2 / NEXT_PUBLIC_*_VAULT`,
  );
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

/**
 * Leading `market_id` arg for v2 vault targets; empty for legacy per-market contracts.
 * Position matters: the v2 ABI is `bet(market_id, outcome)` / `resolve(market_id, winning_outcome)`.
 */
function vaultIdArgs(opts: BuildPlanOptions): CasperCallArg[] {
  if (opts.vaultMarketId === undefined) {
    return [];
  }
  assertNonEmpty("vaultMarketId", opts.vaultMarketId);
  return [{ name: "market_id", clType: "string", value: opts.vaultMarketId }];
}

/** Build the plan for escrowing a stake onto an outcome (payable `bet`). */
export function buildBetPlan(input: PlaceBetInput, opts: BuildPlanOptions): CasperCallPlan {
  assertNonEmpty("marketContract", opts.marketContract);
  assertNonEmpty("outcomeKey", input.outcomeKey);
  assertPositiveMotes("amountMotes", input.amountMotes);
  return {
    targetContract: opts.marketContract,
    entryPoint: "bet",
    args: [...vaultIdArgs(opts), { name: "outcome", clType: "string", value: input.outcomeKey }],
    attachedMotes: input.amountMotes,
    gasMotes: opts.gasMotes ?? DEFAULT_BET_GAS_MOTES,
    usesProxy: true, // payable → routed through proxy_caller_with_return.wasm
  };
}

/**
 * Build the plan for a runtime `create_market` on the v2 vault (payable — the creation bond is
 * the attached value).
 *
 * Argument ORDER is the ABI, not a preference: `create_market(market_id, question, category,
 * oracle, fee_bps, deadline, outcomes)`. Odra matches runtime args by name, but keeping the plan
 * in declaration order means a signature change shows up as a diff here rather than as a
 * mysterious revert on chain.
 *
 * This entry point exists only on the singleton vault. A per-market v1 package has no notion of
 * creating anything, so a caller that has not routed to a v2 vault is a configuration error worth
 * failing loudly on.
 */
export function buildCreateMarketPlan(
  input: CreateMarketInput,
  opts: BuildPlanOptions,
): CasperCallPlan {
  assertNonEmpty("marketContract", opts.marketContract);
  assertNonEmpty("marketId", input.marketId);
  assertNonEmpty("question", input.question);
  assertNonEmpty("category", input.category);
  assertNonEmpty("oracle", input.oracle);
  assertPositiveMotes("bondMotes", input.bondMotes);
  if (opts.vaultMarketId === undefined) {
    throw new Error(
      `create_market exists only on the singleton HunchVault v2 — market '${input.marketId}' routed to ` +
        `a per-market package instead (set NEXT_PUBLIC_*_VAULT_V2, and keep the slug out of NEXT_PUBLIC_*_MARKET_ADDRS)`,
    );
  }
  if (input.outcomeKeys.length < 2) {
    throw new Error(`a market needs at least two outcomes, got ${input.outcomeKeys.length}`);
  }
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps >= 10_000) {
    throw new Error(`feeBps must be an integer in [0, 10000), got: ${input.feeBps}`);
  }
  if (!Number.isInteger(input.deadlineMs) || input.deadlineMs <= 0) {
    throw new Error(`deadlineMs must be a positive epoch-ms integer, got: ${input.deadlineMs}`);
  }
  return {
    targetContract: opts.marketContract,
    entryPoint: "create_market",
    args: [
      { name: "market_id", clType: "string", value: input.marketId },
      { name: "question", clType: "string", value: input.question },
      { name: "category", clType: "string", value: input.category },
      { name: "oracle", clType: "key", value: input.oracle },
      { name: "fee_bps", clType: "u32", value: String(input.feeBps) },
      { name: "deadline", clType: "u64", value: String(input.deadlineMs) },
      { name: "outcomes", clType: "string-list", values: [...input.outcomeKeys] },
    ],
    attachedMotes: input.bondMotes,
    gasMotes: opts.gasMotes ?? DEFAULT_CREATE_GAS_MOTES,
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
    args: [
      ...vaultIdArgs(opts),
      { name: "winning_outcome", clType: "string", value: input.winningOutcomeKey },
    ],
    attachedMotes: "0",
    gasMotes: opts.gasMotes ?? DEFAULT_RESOLVE_GAS_MOTES,
    usesProxy: false, // non-payable → direct package-targeting transaction
  };
}
