import { describe, it, expect, afterEach } from "vitest";
import { buildMainnetPreflight, renderPreflight } from "@/core/mainnet-preflight";
import { GET as preflightGET } from "@/app/api/deploy-plan/mainnet-preflight/route";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("mainnet preflight — the dry run that cannot spend", () => {
  it("performs zero transactions and totals a positive cost", () => {
    const plan = buildMainnetPreflight();
    expect(plan.transactionsPerformed).toBe(false);
    expect(plan.network).toBe("mainnet");
    expect(plan.totalCostCspr).toBeGreaterThan(0);
    expect(plan.marketCount).toBeGreaterThan(0);
    // The total is the sum of the line items.
    const sum = plan.costPlan.reduce((s, i) => s + i.subtotalCspr, 0);
    expect(Math.round(sum * 1000) / 1000).toBe(plan.totalCostCspr);
  });

  it("includes infra installs and per-market create+register in the plan", () => {
    const plan = buildMainnetPreflight();
    const steps = plan.costPlan.map((i) => i.step).join(" | ");
    expect(steps).toContain("HunchVault v2");
    expect(steps).toContain("create_market");
    expect(steps).toContain("register_market");
  });

  it("omitting the house seed lowers the total", () => {
    const withSeed = buildMainnetPreflight({ seedHouseLiquidity: true }).totalCostCspr;
    const without = buildMainnetPreflight({ seedHouseLiquidity: false }).totalCostCspr;
    expect(without).toBeLessThan(withSeed);
  });

  it("is NOT cleared while unaudited, and reports the audit gate", () => {
    delete process.env.NEXT_PUBLIC_AUDIT_STATUS;
    const plan = buildMainnetPreflight();
    expect(plan.cleared).toBe(false);
    expect(plan.audit.status).toBe("unaudited");
    expect(plan.audit.perBetCapCspr).toBe(25);
  });

  it("is cleared once audited", () => {
    process.env.NEXT_PUBLIC_AUDIT_STATUS = "audited";
    expect(buildMainnetPreflight().cleared).toBe(true);
  });

  it("renders a readable plan", () => {
    const text = renderPreflight(buildMainnetPreflight());
    expect(text).toContain("DRY RUN");
    expect(text).toContain("TOTAL");
    expect(text).toContain("zero transactions");
  });
});

describe("GET /api/deploy-plan/mainnet-preflight", () => {
  it("returns JSON with transactionsPerformed:false", async () => {
    const res = await preflightGET(new Request("http://localhost/api/deploy-plan/mainnet-preflight"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.transactionsPerformed).toBe(false);
    expect(json.totalCostCspr).toBeGreaterThan(0);
  });

  it("serves a text plan on ?format=text", async () => {
    const res = await preflightGET(new Request("http://localhost/api/deploy-plan/mainnet-preflight?format=text"));
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("Mainnet deploy preflight");
  });
});
