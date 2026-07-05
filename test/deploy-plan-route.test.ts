import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/deploy-plan/route";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { DEFAULT_NETWORK } from "@/config/network";

const URL = "http://localhost/api/deploy-plan";

describe("GET /api/deploy-plan", () => {
  it("serves the mainnet deploy manifest for the whole catalogue", async () => {
    const res = await GET(new Request(`${URL}?network=mainnet`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.network).toBe("mainnet");
    expect(json.chainName).toBe("casper");
    expect(json.marketCount).toBe(MARKET_DEFINITIONS.length);
    expect(json.guardrails.showUnauditedBanner).toBe(true);
    expect(json.infrastructure.map((c: { contract: string }) => c.contract)).toEqual(
      expect.arrayContaining(["MarketFactory", "OracleRegistry"]),
    );
  });

  it("serves testnet too", async () => {
    const json = await (await GET(new Request(`${URL}?network=testnet`))).json();
    expect(json.network).toBe("testnet");
    expect(json.chainName).toBe("casper-test");
  });

  it("defaults to the default network when the param is missing/invalid", async () => {
    const missing = await (await GET(new Request(URL))).json();
    expect(missing.network).toBe(DEFAULT_NETWORK);
    const bogus = await (await GET(new Request(`${URL}?network=devnet`))).json();
    expect(bogus.network).toBe(DEFAULT_NETWORK);
  });
});
