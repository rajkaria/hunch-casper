/**
 * The economy's MCP surface — the public, composable interface any Casper agent uses to
 * discover markets, read odds + oracle reputation, quote a bet (get the x402 challenge), and
 * place a bet (x402-gated). The Prophets use exactly these tools; so can any third-party agent.
 * This module is transport-agnostic: `MCP_TOOLS` is the tool catalogue and `callTool` dispatches
 * one call against the app's ports. `app/api/mcp/route.ts` wraps it in JSON-RPC 2.0 / MCP.
 */

import { createContainer } from "@/lib/container";
import { agentBet } from "@/lib/agent-bet";
import type { X402PaymentProof } from "@/ports/payment";
import { isCasperNetwork, DEFAULT_NETWORK } from "@/config/network";
import type { CasperNetwork } from "@/config/network";
import { computeOdds } from "@/core/parimutuel-odds";
import { computeAgentLeaderboard } from "@/core/agent-leaderboard";
import type { Market } from "@/core/types";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const NETWORK_PROP = {
  network: { type: "string", enum: ["testnet", "mainnet"], description: "Casper network (default testnet)" },
};

export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_markets",
    description: "List open markets in the Hunch economy, with pool-implied odds. Filter by category.",
    inputSchema: {
      type: "object",
      properties: {
        ...NETWORK_PROP,
        category: { type: "string", enum: ["casper-native", "provably-fair", "rwa", "meta"] },
      },
    },
  },
  {
    name: "get_market",
    description: "Get one market by slug, with its outcomes and pool-implied odds.",
    inputSchema: {
      type: "object",
      properties: { ...NETWORK_PROP, slug: { type: "string" } },
      required: ["slug"],
    },
  },
  {
    name: "get_odds",
    description: "Get the current pool-implied odds (probability + payout multiple) for a market.",
    inputSchema: {
      type: "object",
      properties: { ...NETWORK_PROP, slug: { type: "string" } },
      required: ["slug"],
    },
  },
  {
    name: "quote_bet",
    description:
      "Quote a bet: returns the x402 payment requirement to pay and the payout if the outcome wins. Step 1 of placing a bet.",
    inputSchema: {
      type: "object",
      properties: {
        ...NETWORK_PROP,
        marketId: { type: "string", description: "The market id (network:slug)" },
        outcomeKey: { type: "string" },
        amountMotes: { type: "string", description: "Stake in motes (1 CSPR = 1e9 motes)" },
      },
      required: ["marketId", "outcomeKey", "amountMotes"],
    },
  },
  {
    name: "place_bet",
    description:
      "Place a bet (x402-gated). Call with a paymentProof from quote_bet's requirement; without one, returns the requirement to pay first.",
    inputSchema: {
      type: "object",
      properties: {
        ...NETWORK_PROP,
        marketId: { type: "string" },
        outcomeKey: { type: "string" },
        amountMotes: { type: "string" },
        bettor: { type: "string", description: "The agent's public key or agent:<name>" },
        paymentProof: { type: "object", description: "x402 proof { scheme, deployHash, nonce }" },
      },
      required: ["marketId", "outcomeKey", "amountMotes", "bettor"],
    },
  },
  {
    name: "get_oracle_reputation",
    description: "Get an oracle's on-chain reputation (identity + resolution accuracy). Defaults to the Arbiter.",
    inputSchema: {
      type: "object",
      properties: { oracleId: { type: "string", description: "Oracle id (default 'arbiter')" } },
    },
  },
  {
    name: "get_leaderboard",
    description:
      "Get the economy's leaderboards: agent realized PnL (the Prophets, ranked) and oracle-accuracy. These are the boards the meta-markets resolve against.",
    inputSchema: { type: "object", properties: { ...NETWORK_PROP } },
  },
];

function pickNetwork(args: Record<string, unknown>): CasperNetwork {
  return isCasperNetwork(args.network) ? args.network : DEFAULT_NETWORK;
}

function marketView(m: Market) {
  const odds = computeOdds(m);
  return {
    id: m.id,
    slug: m.slug,
    title: m.title,
    category: m.category,
    status: m.status,
    deadlineIso: m.deadlineIso,
    totalStakedMotes: m.totalStakedMotes,
    outcomes: m.outcomes.map((o) => {
      const od = odds.find((x) => x.outcomeKey === o.key);
      return {
        key: o.key,
        label: o.label,
        impliedProbability: od?.impliedProbability ?? 0,
        payoutMultiple: od?.payoutMultiple ?? 0,
      };
    }),
  };
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Dispatch one MCP tool call against the app's ports. */
export async function callTool(name: string, rawArgs: unknown): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const network = pickNetwork(args);
  const container = createContainer(network);

  switch (name) {
    case "list_markets": {
      const category = typeof args.category === "string" ? args.category : undefined;
      const markets = await container.store.list({
        network,
        category: category as Market["category"] | undefined,
      });
      return { ok: true, data: { network, markets: markets.map(marketView) } };
    }
    case "get_market": {
      const m = await container.store.get(String(args.slug ?? ""), network);
      if (!m) return { ok: false, error: `no market '${String(args.slug)}' on ${network}` };
      return { ok: true, data: marketView(m) };
    }
    case "get_odds": {
      const m = await container.store.get(String(args.slug ?? ""), network);
      if (!m) return { ok: false, error: `no market '${String(args.slug)}' on ${network}` };
      return { ok: true, data: { slug: m.slug, odds: computeOdds(m) } };
    }
    case "quote_bet": {
      const res = await agentBet(container, {
        marketId: String(args.marketId ?? ""),
        outcomeKey: String(args.outcomeKey ?? ""),
        amountMotes: String(args.amountMotes ?? ""),
        bettor: "agent:quote",
      });
      if (res.status === "error") return { ok: false, error: res.error };
      return { ok: true, data: res };
    }
    case "place_bet": {
      const res = await agentBet(container, {
        marketId: String(args.marketId ?? ""),
        outcomeKey: String(args.outcomeKey ?? ""),
        amountMotes: String(args.amountMotes ?? ""),
        bettor: String(args.bettor ?? ""),
        paymentProof: args.paymentProof as X402PaymentProof | undefined,
      });
      if (res.status === "error") return { ok: false, error: res.error };
      return { ok: true, data: res };
    }
    case "get_oracle_reputation": {
      const oracleId = typeof args.oracleId === "string" && args.oracleId.length > 0 ? args.oracleId : "arbiter";
      return { ok: true, data: await container.oracle.reputationOf(oracleId) };
    }
    case "get_leaderboard": {
      const agentPnl = computeAgentLeaderboard(await container.store.settledEntries(network));
      const oracleAccuracy = (await container.oracle.leaderboard()).map((o) => ({
        oracleId: o.oracleId,
        name: o.name,
        accuracyBps: o.accuracyBps,
        resolvedCount: o.resolvedCount,
      }));
      return { ok: true, data: { network, agentPnl, oracleAccuracy } };
    }
    default:
      return { ok: false, error: `unknown tool '${name}'` };
  }
}
