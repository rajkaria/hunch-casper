/**
 * GET /api/agent/activity — the live agent-action feed (Genesis creates, Prophets bet, Arbiter
 * resolves), newest first. Powers the /agents dashboard.
 */

import { NextResponse } from "next/server";
import { listActions } from "@/adapters/mock/activity-log";

export async function GET(req: Request): Promise<Response> {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "50");
  const actions = listActions(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 60) : 50);
  return NextResponse.json({ actions });
}
