/**
 * POST /api/chain/resolve — the oracle posts a market's winning outcome, triggering on-chain
 * settlement. This is the Arbiter's action in the full economy (S6/S10); for the S2 thin
 * slice it is an operator-triggered resolve so the bet → resolve loop is demonstrable from
 * the UI.
 *
 * SAFETY: resolution is a money-path authority. With the mock adapter it moves no real value,
 * so the route is open for the demo. In **real** mode it is FAIL-CLOSED: it stays disabled
 * unless an operator explicitly sets `CASPER_ENABLE_RESOLVE_ROUTE=true` AND presents the shared
 * `CASPER_RESOLVE_OPERATOR_TOKEN` — because the server holds the oracle key, the on-chain
 * `assert_oracle` check does NOT gate *who* triggered the HTTP call. (The autonomous Arbiter
 * identity replaces this operator gate in S6/S10.)
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { hydrateEconomyState, persistEconomyState } from "@/adapters/persist/economy-state";
import { isCasperNetwork } from "@/config/network";
import { chainMode } from "@/config/chain-mode";

/** Real mode: OFF unless explicitly enabled. Mock mode: ON unless explicitly disabled. */
function resolveRouteEnabled(): boolean {
  return chainMode() === "real"
    ? process.env.CASPER_ENABLE_RESOLVE_ROUTE === "true"
    : process.env.CASPER_ENABLE_RESOLVE_ROUTE !== "false";
}

/** Real mode requires a matching operator token; mock mode moves no value → no token needed. */
function operatorAuthorized(req: Request): boolean {
  if (chainMode() !== "real") return true;
  const expected = process.env.CASPER_RESOLVE_OPERATOR_TOKEN;
  if (!expected) return false; // fail closed: no configured token ⇒ no one is authorized
  const provided = req.headers.get("x-operator-token") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  if (!resolveRouteEnabled()) {
    return NextResponse.json({ error: "resolve route is disabled" }, { status: 403 });
  }
  if (!operatorAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized: missing or invalid operator token" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { network, marketId, winningOutcomeKey, oracleId } = body ?? {};

  if (!isCasperNetwork(network)) {
    return NextResponse.json({ error: "network must be 'testnet' or 'mainnet'" }, { status: 400 });
  }
  if (typeof marketId !== "string" || marketId.length === 0) {
    return NextResponse.json({ error: "marketId is required" }, { status: 400 });
  }
  if (typeof winningOutcomeKey !== "string" || winningOutcomeKey.length === 0) {
    return NextResponse.json({ error: "winningOutcomeKey is required" }, { status: 400 });
  }
  const oracle = typeof oracleId === "string" && oracleId.length > 0 ? oracleId : "arbiter";
  // The operator asserts ground truth, so a resolution is accurate by default; an explicit
  // `accurate: false` lets a demo record a wrong call and watch the oracle's reputation drop.
  const accurate = (body?.accurate ?? true) !== false;

  // Settle on top of the persisted economy (no-op when KV is unconfigured); the flush is
  // awaited after the mutation below for the same serverless-freeze reason as the tick route.
  await hydrateEconomyState();
  const container = createContainer(network);
  const slug = marketId.startsWith(`${network}:`) ? marketId.slice(network.length + 1) : marketId;
  const market = await container.store.get(slug, network);
  if (!market) {
    return NextResponse.json({ error: `unknown market '${marketId}'` }, { status: 400 });
  }
  if (!market.outcomes.some((o) => o.key === winningOutcomeKey)) {
    return NextResponse.json({ error: `'${winningOutcomeKey}' is not an outcome of ${marketId}` }, { status: 400 });
  }

  // Idempotency: if the market is already settled, do NOT re-submit an on-chain resolve — the
  // vault's assert_open would revert it and burn gas, and a second body could echo a different
  // winner than the one that actually settled. Return the recorded settlement verbatim.
  const existing = await container.store.settlementFor(market.id);
  if (existing) {
    return NextResponse.json({
      network,
      marketId: market.id,
      winningOutcomeKey: existing.winningOutcomeKey,
      oracleId: oracle,
      settlement: existing,
      alreadySettled: true,
    });
  }

  try {
    const res = await container.chain.resolveMarket({ marketId: market.id, winningOutcomeKey, oracleId: oracle });
    // Settle off-chain through the pure payout engine — the exact numbers the on-chain claim mirrors.
    const settlement = await container.store.settle(market.id, winningOutcomeKey);
    // Record the resolution against the oracle's reputation (the OracleRegistry mirror). Defaults to
    // accurate (the operator asserts truth); an explicit `accurate: false` demos a reputation hit.
    const reputation = await container.oracle.recordResolution(oracle, market.id, accurate);
    await persistEconomyState();
    return NextResponse.json({
      deployHash: res.deployHash,
      explorerUrl: res.explorerUrl,
      network,
      marketId: market.id,
      winningOutcomeKey,
      oracleId: oracle,
      settlement,
      oracleReputation: reputation,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "chain submission failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
