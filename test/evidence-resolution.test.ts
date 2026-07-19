import { describe, it, expect, beforeEach } from "vitest";
import { resolveMarket } from "@/agent/arbiter";
import { createContainer } from "@/lib/container";
import { GET as evidenceGET } from "@/app/api/markets/[slug]/evidence/route";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { __resetEvidenceStore } from "@/adapters/mock/mock-evidence-store";
import { __resetResolutionEvidence, resolutionEvidenceFor } from "@/adapters/mock/resolution-evidence-ledger";

beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetCreatedMarkets();
  __resetEvidenceStore();
  __resetResolutionEvidence();
});

const SLUG = "cspr-price-05-aug";

describe("Arbiter publishes replayable evidence at resolution", () => {
  it("stores a bundle, records the linkage, and stamps the action with the hashes", async () => {
    const container = createContainer("testnet");
    const action = await resolveMarket(container, SLUG);
    expect(action).not.toBeNull();
    expect(action!.recipeHash?.startsWith("sha256:")).toBe(true);
    expect(action!.evidenceBundleHash?.startsWith("sha256:")).toBe(true);

    const link = resolutionEvidenceFor(`testnet:${SLUG}`);
    expect(link).not.toBeNull();
    expect(link!.bundleHash).toBe(action!.evidenceBundleHash);

    // The bundle is retrievable from the content-addressed store by its hash.
    const bundle = await container.evidence.get(link!.bundleHash);
    expect(bundle).not.toBeNull();
    expect(bundle!.marketId).toBe(`testnet:${SLUG}`);
  });
});

describe("GET /api/markets/[slug]/evidence", () => {
  it("404s before resolution, then returns a replay-verified bundle after", async () => {
    const container = createContainer("testnet");

    const before = await evidenceGET(new Request(`http://localhost/api/markets/${SLUG}/evidence?network=testnet`), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(before.status).toBe(404);

    await resolveMarket(container, SLUG);

    const after = await evidenceGET(new Request(`http://localhost/api/markets/${SLUG}/evidence?network=testnet`), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(after.status).toBe(200);
    const json = await after.json();
    expect(json.verification.ok).toBe(true);
    expect(json.verification.recipeHashMatches).toBe(true);
    expect(json.verification.bundleHashMatches).toBe(true);
    expect(json.verification.outcomeMatches).toBe(true);
    expect(json.bundle.winningOutcomeKey).toBeTruthy();
  });
});
