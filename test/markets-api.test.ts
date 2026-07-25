import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/adapters/persist/economy-state", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/adapters/persist/economy-state")>();
  return { ...original, refreshEconomyState: vi.fn(async () => {}) };
});

import { GET as listGET } from "@/app/api/markets/route";
import { GET as detailGET } from "@/app/api/markets/[slug]/route";
import { refreshEconomyState } from "@/adapters/persist/economy-state";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { DEFAULT_NETWORK } from "@/config/network";

const refreshed = vi.mocked(refreshEconomyState);
beforeEach(() => refreshed.mockClear());

const LIST = "http://localhost/api/markets";

describe("GET /api/markets", () => {
  it("returns the full catalogue for a network", async () => {
    const res = await listGET(new Request(`${LIST}?network=testnet`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(MARKET_DEFINITIONS.length);
    expect(json.markets.every((m: { network: string }) => m.network === "testnet")).toBe(true);
  });

  it("filters by category", async () => {
    const res = await listGET(new Request(`${LIST}?network=testnet&category=rwa`));
    const json = await res.json();
    expect(json.markets.length).toBeGreaterThan(0);
    expect(json.markets.every((m: { category: string }) => m.category === "rwa")).toBe(true);
  });

  it("ignores an unknown category (returns all)", async () => {
    const res = await listGET(new Request(`${LIST}?network=testnet&category=bogus`));
    const json = await res.json();
    expect(json.count).toBe(MARKET_DEFINITIONS.length);
  });

  it("defaults a missing network to DEFAULT_NETWORK", async () => {
    const res = await listGET(new Request(LIST));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.network).toBe(DEFAULT_NETWORK);
    expect(json.count).toBe(MARKET_DEFINITIONS.length);
  });

  it("rejects an invalid network", async () => {
    expect((await listGET(new Request(`${LIST}?network=devnet`))).status).toBe(400);
  });

  // `?fresh=1` is what a board re-read right after a write sends: without it a warm instance can
  // answer from a view up to HYDRATE_TTL_MS old and render the write as never having happened.
  it("forces a KV re-read only when ?fresh=1 is asked for", async () => {
    await listGET(new Request(`${LIST}?network=testnet`));
    expect(refreshed).not.toHaveBeenCalled();
    await listGET(new Request(`${LIST}?network=testnet&fresh=1`));
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/markets/[slug]", () => {
  function detail(slug: string, network = "testnet"): Promise<Response> {
    return detailGET(new Request(`http://localhost/api/markets/${slug}?network=${network}`), {
      params: Promise.resolve({ slug }),
    });
  }

  it("returns a single market", async () => {
    const res = await detail("btc-150k-aug");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.market.slug).toBe("btc-150k-aug");
    expect(json.market.network).toBe("testnet");
  });

  it("404s an unknown slug", async () => {
    expect((await detail("no-such-market")).status).toBe(404);
  });

  it("defaults a missing network to DEFAULT_NETWORK", async () => {
    const res = await detailGET(new Request("http://localhost/api/markets/btc-150k-aug"), {
      params: Promise.resolve({ slug: "btc-150k-aug" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.market.network).toBe(DEFAULT_NETWORK);
  });

  it("rejects an invalid network", async () => {
    expect((await detail("btc-150k-aug", "devnet")).status).toBe(400);
  });

  it("forces a KV re-read only when ?fresh=1 is asked for — the post-bet refetch", async () => {
    await detail("btc-150k-aug");
    expect(refreshed).not.toHaveBeenCalled();
    await detailGET(new Request("http://localhost/api/markets/btc-150k-aug?network=testnet&fresh=1"), {
      params: Promise.resolve({ slug: "btc-150k-aug" }),
    });
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});
