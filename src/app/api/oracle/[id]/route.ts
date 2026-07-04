/**
 * GET /api/oracle/[id] — an oracle's on-chain reputation (identity + accuracy).
 *
 * Reads the `OracleRegistry` mirror. Reputation is network-agnostic (one oracle identity across
 * networks), so it uses the default container's oracle adapter. This is the RWA-oracle thesis
 * made queryable: the Arbiter's accuracy is public, and the `arbiter-accuracy-95` meta-market
 * resolves against exactly this number.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const reputation = await createContainer().oracle.reputationOf(id);
  return NextResponse.json({ reputation });
}
