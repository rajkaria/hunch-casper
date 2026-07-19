import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET as oddsGET } from "@/app/api/odds/route";
import { GET as historyGET } from "@/app/api/odds/history/route";
import { resolveMarket } from "@/agent/arbiter";
import { createContainer } from "@/lib/container";
import { assessMarketFields } from "@/core/category-policy";
import { recipeFromBinding, validateRecipe } from "@/core/resolution-recipe";
import { MARKET_DEFINITIONS, findDefinition } from "@/core/catalogue";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { __resetEvidenceStore } from "@/adapters/mock/mock-evidence-store";
import { __resetResolutionEvidence } from "@/adapters/mock/resolution-evidence-ledger";
import { __resetSharedQueryMeter } from "@/lib/query-meter";

const savedEnv = { ...process.env };
beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetCreatedMarkets();
  __resetEvidenceStore();
  __resetResolutionEvidence();
  __resetSharedQueryMeter();
});
afterEach(() => {
  process.env = { ...savedEnv };
});

const PUBLIC_GOOD = [
  "casper-condor-upgrade-ships-aug",
  "casper-validator-health-90",
  "casper-grant-milestones-aug",
];

describe("S27 public-good markets", () => {
  it("are in the catalogue, pass the category policy, and carry valid recipes", () => {
    for (const slug of PUBLIC_GOOD) {
      const def = findDefinition(slug);
      expect(def, `missing ${slug}`).toBeDefined();
      expect(assessMarketFields({ title: def!.title, subtitle: def!.subtitle, description: def!.resolver.description }).allowed).toBe(true);
      const recipe = recipeFromBinding(def!.resolver, def!.outcomes.map((o) => o.key), def!.deadlineIso);
      expect(validateRecipe(recipe).ok, `invalid recipe for ${slug}`).toBe(true);
    }
  });

  it("the whole catalogue still passes the category policy", () => {
    for (const def of MARKET_DEFINITIONS) {
      expect(assessMarketFields({ title: def.title, subtitle: def.subtitle }).allowed).toBe(true);
    }
  });
});

describe("GET /api/odds — the live probability feed", () => {
  it("returns implied probabilities for open markets on the free tier", async () => {
    const res = await oddsGET(new Request("http://localhost/api/odds?network=testnet&caller=feed-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBeGreaterThan(0);
    expect(json.meter.tier).toBe("free");
    const one = json.odds[0];
    expect(one.outcomes[0].probability).toBeGreaterThanOrEqual(0);
    expect(one.outcomes[0].probability).toBeLessThanOrEqual(1);
    expect(res.headers.get("cache-control")).toContain("s-maxage");
  });

  it("filters to one market with ?slug and 404s an unknown one", async () => {
    const ok = await oddsGET(new Request("http://localhost/api/odds?network=testnet&slug=cspr-price-05-aug&caller=f2"));
    expect((await ok.json()).count).toBe(1);
    const bad = await oddsGET(new Request("http://localhost/api/odds?network=testnet&slug=ghost&caller=f3"));
    expect(bad.status).toBe(404);
  });

  it("meters: past the free tier it returns a 402 x402 challenge", async () => {
    process.env.ORACLE_FREE_QUERIES_PER_HOUR = "0";
    const res = await oddsGET(new Request("http://localhost/api/odds?network=testnet&caller=payer-9"));
    expect(res.status).toBe(402);
    expect((await res.json()).accepts[0].scheme).toBe("casper-x402");
  });
});

describe("GET /api/odds/history — calibration export", () => {
  it("returns a calibration curve JSON after some markets settle", async () => {
    const container = createContainer("testnet");
    await resolveMarket(container, "cspr-price-05-aug");
    await resolveMarket(container, "cspr-mcap-1b-aug");

    const res = await historyGET(new Request("http://localhost/api/odds/history?network=testnet"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settledMarkets).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(json.calibration.bins)).toBe(true);
    expect(typeof json.calibration.expectedCalibrationError).toBe("number");
  });

  it("serves a deterministic CSV on ?format=csv", async () => {
    const container = createContainer("testnet");
    await resolveMarket(container, "cspr-price-05-aug");
    const a = await (await historyGET(new Request("http://localhost/api/odds/history?network=testnet&format=csv"))).text();
    const b = await (await historyGET(new Request("http://localhost/api/odds/history?network=testnet&format=csv"))).text();
    expect(a).toBe(b);
    expect(a.split("\n")[0]).toBe("lower,upper,count,meanForecast,observedRate");
  });
});
