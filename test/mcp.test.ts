import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST as mcpPOST } from "@/app/api/mcp/route";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { persistEconomyState } from "@/adapters/persist/economy-state";

// Spy on the KV flush (a no-op in tests) so the route's "persist only on a real mutation" contract
// is observable. Everything else in the module stays real.
vi.mock("@/adapters/persist/economy-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/adapters/persist/economy-state")>();
  return { ...actual, persistEconomyState: vi.fn(actual.persistEconomyState) };
});

beforeEach(() => {
  __resetLedger();
  __resetOracleLedger();
  __resetConsumedNonces();
  vi.mocked(persistEconomyState).mockClear();
});

const URL = "http://localhost/api/mcp";
function rpc(method: string, params?: unknown, id: number | string = 1): Promise<Response> {
  return mcpPOST(
    new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
}
async function callTool(name: string, args: unknown) {
  const res = await rpc("tools/call", { name, arguments: args });
  const json = await res.json();
  return json.result;
}
function parseContent(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("MCP server (/api/mcp)", () => {
  it("initializes with server info + tool capability", async () => {
    const json = await (await rpc("initialize")).json();
    expect(json.result.serverInfo.name).toBe("hunch-casper");
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it("lists the tool catalogue", async () => {
    const json = await (await rpc("tools/list")).json();
    const names = json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["list_markets", "get_odds", "quote_bet", "place_bet", "get_oracle_reputation"]),
    );
  });

  it("list_markets returns the catalogue with odds", async () => {
    const data = parseContent(await callTool("list_markets", { network: "testnet" }));
    expect(data.markets.length).toBe(MARKET_DEFINITIONS.length);
    expect(data.markets[0].outcomes[0]).toHaveProperty("impliedProbability");
  });

  it("get_oracle_reputation returns the Arbiter's accuracy", async () => {
    const data = parseContent(await callTool("get_oracle_reputation", {}));
    expect(data.name).toBe("Arbiter");
    expect(data.accuracyBps).toBe(9609);
  });

  // btc-150k-aug matured on Aug 1 and is retired history now — betting against it is refused, so
  // the bet paths below run against its live successor, btc-70k-nov.
  it("quote_bet returns an x402 requirement + payout preview (no proof needed)", async () => {
    // The successor carries no seed liquidity, and a payout preview against an empty book is just
    // the stake handed back. Stake the other side first so the quote prices a real pool.
    const other = parseContent(
      await callTool("place_bet", {
        network: "testnet",
        marketId: "testnet:btc-70k-nov",
        outcomeKey: "no",
        amountMotes: "3000000000",
        bettor: "agent:contrarian",
      }),
    );
    const otherPlaced = parseContent(
      await callTool("place_bet", {
        network: "testnet",
        marketId: "testnet:btc-70k-nov",
        outcomeKey: "no",
        amountMotes: "3000000000",
        bettor: "agent:contrarian",
        paymentProof: { scheme: "casper-x402", deployHash: "opposing", nonce: other.requirement.nonce },
      }),
    );
    expect(otherPlaced.status).toBe("placed");

    const data = parseContent(
      await callTool("quote_bet", {
        network: "testnet",
        marketId: "testnet:btc-70k-nov",
        outcomeKey: "yes",
        amountMotes: "1000000000",
      }),
    );
    expect(data.status).toBe("payment_required");
    expect(data.requirement.nonce).toBeTruthy();
    // Sole backer of yes against a 3 CSPR no pool: the stake back plus the losing pool net of fee.
    expect(BigInt(data.previewPayoutMotes) > 1000000000n).toBe(true);
  });

  it("place_bet is gated: returns the requirement without a proof, places with one", async () => {
    const quote = parseContent(
      await callTool("place_bet", {
        network: "testnet",
        marketId: "testnet:btc-70k-nov",
        outcomeKey: "yes",
        amountMotes: "1000000000",
        bettor: "agent:momentum",
      }),
    );
    expect(quote.status).toBe("payment_required");

    const placed = parseContent(
      await callTool("place_bet", {
        network: "testnet",
        marketId: "testnet:btc-70k-nov",
        outcomeKey: "yes",
        amountMotes: "1000000000",
        bettor: "agent:momentum",
        paymentProof: { scheme: "casper-x402", deployHash: "abc", nonce: quote.requirement.nonce },
      }),
    );
    expect(placed.status).toBe("placed");
    expect(placed.deployHash).toHaveLength(64);
  });

  it("persists the economy snapshot only when place_bet actually places", async () => {
    // A proof-less place_bet is a read (it returns the payment challenge) — no KV write.
    const quote = parseContent(
      await callTool("place_bet", {
        network: "testnet",
        marketId: "testnet:btc-70k-nov",
        outcomeKey: "yes",
        amountMotes: "1000000000",
        bettor: "agent:momentum",
      }),
    );
    expect(quote.status).toBe("payment_required");
    expect(persistEconomyState).not.toHaveBeenCalled();

    const placed = parseContent(
      await callTool("place_bet", {
        network: "testnet",
        marketId: "testnet:btc-70k-nov",
        outcomeKey: "yes",
        amountMotes: "1000000000",
        bettor: "agent:momentum",
        paymentProof: { scheme: "casper-x402", deployHash: "def", nonce: quote.requirement.nonce },
      }),
    );
    expect(placed.status).toBe("placed");
    expect(persistEconomyState).toHaveBeenCalled();
  });

  it("rejects an unknown method", async () => {
    const json = await (await rpc("frobnicate")).json();
    expect(json.error.code).toBe(-32601);
  });
});
