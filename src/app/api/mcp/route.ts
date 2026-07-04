/**
 * POST /api/mcp — the economy's MCP server (JSON-RPC 2.0). Any Casper agent points its MCP
 * client here to `initialize`, `tools/list`, and `tools/call`. Tools cover discover (list/get),
 * odds, quote + place bet (x402-gated), oracle reputation, and the leaderboard — see `lib/mcp.ts`.
 * This is the same public surface the Prophets use; it is not a private bot.
 */

import { NextResponse } from "next/server";
import { MCP_TOOLS, callTool } from "@/lib/mcp";

const SERVER_INFO = { name: "hunch-casper", version: "0.1.0" };
const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function result(id: JsonRpcRequest["id"], data: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result: data });
}
function error(id: JsonRpcRequest["id"], code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export async function POST(req: Request): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return error(null, -32700, "parse error");
  }
  if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return error(body?.id ?? null, -32600, "invalid request");
  }

  const { id, method, params } = body;
  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "The Hunch-on-Casper prediction-market economy. Discover markets, read odds + oracle reputation, quote_bet then place_bet (x402-gated).",
      });
    case "ping":
      return result(id, {});
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "tools/list":
      return result(id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      const res = await callTool(name, params?.arguments);
      if (!res.ok) {
        return result(id, { content: [{ type: "text", text: res.error }], isError: true });
      }
      return result(id, { content: [{ type: "text", text: JSON.stringify(res.data) }] });
    }
    default:
      return error(id, -32601, `method not found: ${method}`);
  }
}
