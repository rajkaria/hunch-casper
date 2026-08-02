/**
 * The blast radius of S30–S34, asserted rather than assumed.
 *
 * Four sprints changed who signs a bet, when the treasury gates betting, where the x402 wire
 * format lives, and what the Arbiter does after a resolution. Every one of those touches a path
 * that already worked. This file pins the pre-existing behaviour that must NOT have moved — the
 * "old features" half of the acceptance criteria — with an emphasis on the deployment shape most
 * people run: one with none of the new features configured.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { POST as betPOST } from "@/app/api/agent/v1/bet/route";
import { createContainer } from "@/lib/container";
import { planCadence, SEEDING_FLOOR_ROUNDS } from "@/core/cadence";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { __resetActivity } from "@/adapters/mock/activity-log";

beforeEach(() => {
  __resetLedger();
  __resetConsumedNonces();
  __resetActivity();
});

const URL_ = "http://localhost/api/agent/v1/bet";
const post = (body: unknown, proof?: unknown) =>
  betPOST(
    new Request(URL_, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(proof ? { "x-payment": Buffer.from(JSON.stringify(proof)).toString("base64") } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const BET = {
  network: "testnet",
  marketId: "testnet:btc-70k-nov",
  outcomeKey: "yes",
  amountMotes: "1000000000",
  bettor: "agent:momentum",
};

describe("the public x402 rail is unchanged for third-party agents", () => {
  it("still answers 402 with the same accepts[] shape", async () => {
    const res = await post(BET);
    expect(res.status).toBe(402);
    const json = await res.json();
    // Field-for-field, because an external agent parses exactly these.
    expect(json.x402Version).toBe(1);
    expect(json.accepts[0].scheme).toBe("casper-x402");
    expect(json.accepts[0].asset).toBe("CSPR");
    expect(json.accepts[0].maxAmountRequired).toBe("1000000000");
    expect(json.accepts[0].payTo).toBeTruthy();
    expect(json.accepts[0].nonce).toBeTruthy();
    expect(json.accepts[0].resource).toContain("btc-70k-nov");
    expect(json.previewPayoutMotes).toBeTruthy();
  });

  it("still places a bet when a valid proof is presented", async () => {
    const nonce = (await (await post(BET)).json()).accepts[0].nonce;
    const res = await post(BET, { scheme: "casper-x402", deployHash: "tx-regression-1", nonce });
    expect(res.status).toBe(200);
    expect((await res.json()).deployHash).toBeTruthy();
  });

  it("still rejects a replayed proof — one payment, one bet", async () => {
    const nonce = (await (await post(BET)).json()).accepts[0].nonce;
    const proof = { scheme: "casper-x402", deployHash: "tx-regression-2", nonce };
    expect((await post(BET, proof)).status).toBe(200);
    expect((await post(BET, proof)).status).toBe(402);
  });

  it("still acknowledges with the payment-response header", async () => {
    const nonce = (await (await post(BET)).json()).accepts[0].nonce;
    const res = await post(BET, { scheme: "casper-x402", deployHash: "tx-regression-3", nonce });
    // Header names are case-insensitive, so moving to the package's lowercase constant is safe —
    // this asserts a consumer reading the old capitalisation still finds it.
    expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
  });
});

describe("a deployment with none of the new features configured is unaffected", () => {
  it("reports no self-signing capability without a fleet seed", () => {
    const saved = process.env.CASPER_FLEET_SEED;
    delete process.env.CASPER_FLEET_SEED;
    try {
      const container = createContainer("testnet");
      // Mock mode: the adapter has no key material at all, which is the safe answer.
      expect(container.chain.canSelfSign?.("agent:momentum") ?? false).toBe(false);
    } finally {
      if (saved !== undefined) process.env.CASPER_FLEET_SEED = saved;
    }
  });

  it("keeps the pre-S31 both-purses betting gate when custody is unstated", () => {
    const plan = planCadence({
      treasuryMotes: "0",
      minFleetBalanceMotes: (1_000_000_000n * BigInt(SEEDING_FLOOR_ROUNDS * 10)).toString(),
      perRoundTreasuryCostMotes: "1000000000",
      perRoundAgentCostMotes: "1000000000",
    });
    expect(plan.allowProphetBets).toBe(false);
  });

  it("keeps resolution unthrottled at every runway level — it pays people what they are owed", () => {
    for (const treasuryMotes of ["0", "1000000000", "1000000000000"]) {
      const plan = planCadence({
        treasuryMotes,
        minFleetBalanceMotes: "0",
        perRoundTreasuryCostMotes: "1000000000",
        perRoundAgentCostMotes: "1000000000",
      });
      // There is no `allowResolution` flag by design: nothing in the plan can switch it off.
      expect(Object.keys(plan)).not.toContain("allowResolution");
    }
  });
});

describe("the mock adapter still satisfies the port after four sprints of additions", () => {
  it("omits every optional capability rather than half-implementing one", () => {
    const { chain } = createContainer("testnet");
    // Each of these is optional precisely so the mock can decline it; a mock that answered would
    // make CI green on a path production takes differently.
    expect(chain.buildAgentRegistrationTransaction).toBeUndefined();
    expect(chain.dispatchResolution).toBeUndefined();
  });

  it("still implements everything the port requires", () => {
    const { chain } = createContainer("testnet");
    for (const method of ["getBlockHeight", "placeBet", "resolveMarket", "createMarket", "anchorResolution"]) {
      expect(typeof (chain as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });
});
