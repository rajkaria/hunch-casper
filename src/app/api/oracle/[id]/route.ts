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
import { peekOracleReputation } from "@/adapters/mock/oracle-ledger";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  // Peek first: a read must not fabricate a 0/0 reputation for an arbitrary id, and it must not
  // insert one either (the ensure-on-read would pollute the leaderboard and the KV snapshot).
  if (!peekOracleReputation(id)) {
    return NextResponse.json({ error: `unknown oracle '${id}'` }, { status: 404 });
  }
  const reputation = await createContainer().oracle.reputationOf(id);
  return NextResponse.json({ reputation });
}
