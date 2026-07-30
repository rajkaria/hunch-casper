import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createContainer } from "@/lib/container";
import {
  createMarket,
  creationBondMotes,
  creationBondPaymentBlocker,
  exportConsumedBondPayments,
  importConsumedBondPayments,
  __resetConsumedBonds,
} from "@/lib/market-create";
import { NATIVE_TRANSFER_MINIMUM_MOTES } from "@/config/network";
import type { CreateMarketRequest } from "@/lib/market-create";
import { agentBet, __resetConsumedNonces } from "@/lib/agent-bet";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { previewPayoutMotes } from "@/core/market-payout";

const savedEnv = { ...process.env };
beforeEach(() => {
  __resetLedger();
  __resetCreatedMarkets();
  __resetActivity();
  __resetConsumedBonds();
  __resetConsumedNonces();
});
afterEach(() => {
  process.env = { ...savedEnv };
});

function req(over: Partial<CreateMarketRequest> = {}): CreateMarketRequest {
  return {
    claim: "Will CSPR cross $0.10 by year end",
    creator: "creator-1",
    oracle: "account-hash-arbiter",
    network: "testnet",
    seq: 0,
    deadlineIso: "2026-12-31T00:00:00.000Z",
    source: "coingecko",
    metric: "cspr_usd",
    method: "threshold",
    target: "0.10",
    comparator: "gte",
    seedByFleet: false,
    ...over,
  };
}

/** Run the two-step x402 creation and return the final result. */
async function createWithBond(container: ReturnType<typeof createContainer>, request: CreateMarketRequest) {
  const challenge = await createMarket(container, request);
  if (challenge.status !== "payment_required") return challenge;
  const proof = await container.payment.settle(challenge.requirement, request.creator);
  return createMarket(container, { ...request, paymentProof: proof });
}

describe("human market creation — x402 bond handshake", () => {
  it("step 1 returns the bond requirement + recipe hash without creating", async () => {
    const container = createContainer("testnet");
    const res = await createMarket(container, req());
    expect(res.status).toBe("payment_required");
    if (res.status === "payment_required") {
      expect(res.bondMotes).toBe(creationBondMotes());
      expect(res.recipeHash.startsWith("sha256:")).toBe(true);
    }
    // Nothing was registered.
    expect(await container.store.get("user-will-cspr-cross-0-10-by-year-end-0", "testnet")).toBeNull();
  });

  it("step 2 creates the market once the bond is paid", async () => {
    const container = createContainer("testnet");
    const res = await createWithBond(container, req());
    expect(res.status).toBe("created");
    if (res.status === "created") {
      expect(res.simulated).toBe(true); // mock chain
      const market = await container.store.get(res.slug, "testnet");
      expect(market).not.toBeNull();
      expect(market!.title.endsWith("?")).toBe(true);
    }
  });

  it("rejects a reused bond proof (defense-in-depth beyond duplicate detection)", async () => {
    const container = createContainer("testnet");
    const challenge = await createMarket(container, req());
    if (challenge.status !== "payment_required") throw new Error("expected challenge");
    const proof = await container.payment.settle(challenge.requirement, "creator-1");
    const first = await createMarket(container, { ...req(), paymentProof: proof });
    expect(first.status).toBe("created");
    // Wipe the registry so the SAME request is no longer caught as a duplicate/exists — this
    // isolates the spent-bond guard: the same proof (same nonce) must still be refused as spent.
    __resetCreatedMarkets();
    const second = await createMarket(container, { ...req(), paymentProof: proof });
    expect(second.status).toBe("error");
    if (second.status === "error") expect(second.code).toBe(402);
  });

  it("a replayed create request (same claim) is caught as a duplicate", async () => {
    const container = createContainer("testnet");
    await createWithBond(container, req());
    const replay = await createWithBond(container, req()); // identical claim + rule
    expect(replay.status).toBe("error");
    if (replay.status === "error") expect(replay.code).toBe(409);
  });

  it("refuses a creator who names themselves as oracle (I5, surfaced early)", async () => {
    const container = createContainer("testnet");
    const res = await createMarket(container, req({ oracle: "creator-1", creator: "creator-1" }));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe(400);
  });

  it("rejects a prohibited market with 422 and a duplicate with 409", async () => {
    const container = createContainer("testnet");
    const banned = await createMarket(container, req({ claim: "Will the senator be assassinated" }));
    expect(banned.status === "error" && banned.code).toBe(422);

    await createWithBond(container, req({ seq: 5 }));
    const dup = await createMarket(container, req({ seq: 6 })); // same claim + rule
    expect(dup.status === "error" && dup.code).toBe(409);
  });

  it("fails closed in real mode without x402 configured (503)", async () => {
    process.env.CASPER_CHAIN_MODE = "real";
    delete process.env.CASPER_X402_PAYTO;
    delete process.env.CASPER_REAL_AGENT_X402;
    const container = createContainer("testnet");
    const res = await createMarket(container, req());
    expect(res.status === "error" && res.code).toBe(503);
  });

  it("a bond quoted before the created-count moved still verifies on the paid retry", async () => {
    const container = createContainer("testnet");
    const challenge = await createMarket(container, req({ seq: 0 }));
    if (challenge.status !== "payment_required") throw new Error("expected challenge");
    const proof = await container.payment.settle(challenge.requirement, "creator-1");
    // Round rollovers move the created-count (and therefore the slug seq) while the visitor is
    // signing the transfer. The requirement is quoted on the RECIPE hash, not the slug, so the
    // retry re-derives the same nonce and the already-paid bond still verifies.
    const res = await createMarket(container, { ...req({ seq: 7 }), paymentProof: proof });
    expect(res.status).toBe("created");
    if (res.status === "created") expect(res.slug.endsWith("-7")).toBe(true);
  });
});

/**
 * The bond's spent-set discipline under a REAL chain call: `create_market` takes 20–120s, and the
 * old code only recorded the settlement AFTER it returned — so two concurrent requests carrying
 * the same deployHash both passed the has-check and one bond opened two markets. The chain stub
 * here is a hand-controlled gate so the in-flight window is exact, not timing-dependent.
 */
describe("bond replay under a slow real chain", () => {
  const ORACLE = `account-hash-${"cc".repeat(32)}`;

  function realEnvWithMockRail(): void {
    process.env.CASPER_CHAIN_MODE = "real";
    process.env.CASPER_REAL_AGENT_X402 = "true"; // keep the deterministic mock x402 rail
    delete process.env.CASPER_X402_PAYTO;
    process.env.CASPER_ORACLE_ACCOUNT = ORACLE;
  }

  /** Real-mode-valid request: the approved oracle, and a deadline inside the vault horizon. */
  function realReq() {
    return req({
      oracle: ORACLE,
      deadlineIso: new Date(Date.now() + 60 * 24 * 60 * 60 * 1_000).toISOString(),
    });
  }

  function containerWithChain(createMarketImpl: () => Promise<{ deployHash: string; explorerUrl: string }>) {
    const base = createContainer("testnet");
    return { ...base, chain: { ...base.chain, createMarket: createMarketImpl } };
  }

  it("claims the bond BEFORE the chain call, so a concurrent replay cannot open a second market", async () => {
    realEnvWithMockRail();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chainCreate = vi.fn(async () => {
      await gate;
      return { deployHash: "aa".repeat(32), explorerUrl: "https://explorer/aa" };
    });
    const container = containerWithChain(chainCreate);

    const request = realReq();
    const challenge = await createMarket(container, request);
    if (challenge.status !== "payment_required") throw new Error("expected challenge");
    const proof = await container.payment.settle(challenge.requirement, request.creator);

    const first = createMarket(container, { ...request, paymentProof: proof });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let it claim + enter the chain call
    expect(chainCreate).toHaveBeenCalledTimes(1); // in flight, not finished

    const second = await createMarket(container, { ...request, paymentProof: proof });
    expect(second.status).toBe("error");
    if (second.status === "error") {
      expect(second.code).toBe(402);
      expect(second.error).toMatch(/already spent/);
    }
    expect(chainCreate).toHaveBeenCalledTimes(1); // the replay never reached the chain

    release();
    expect((await first).status).toBe("created");
  });

  it("releases the claim when the chain create fails, so the same paid bond can retry", async () => {
    realEnvWithMockRail();
    const chainCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error("node timeout"))
      .mockResolvedValue({ deployHash: "bb".repeat(32), explorerUrl: "https://explorer/bb" });
    const container = containerWithChain(chainCreate);

    const request = realReq();
    const challenge = await createMarket(container, request);
    if (challenge.status !== "payment_required") throw new Error("expected challenge");
    const proof = await container.payment.settle(challenge.requirement, request.creator);

    const failed = await createMarket(container, { ...request, paymentProof: proof });
    expect(failed.status === "error" && failed.code).toBe(502);
    // Nothing was opened for that bond — the retry with the SAME settlement must succeed.
    const retried = await createMarket(container, { ...request, paymentProof: proof });
    expect(retried.status).toBe("created");
  });
});

describe("consumed-bond snapshot (KV envelope seam)", () => {
  it("exports what was consumed and imports as a union, dropping junk", async () => {
    importConsumedBondPayments(["hash-a", "hash-b"]);
    importConsumedBondPayments(["hash-b", "hash-c", "", 7 as unknown as string]);
    expect(new Set(exportConsumedBondPayments())).toEqual(new Set(["hash-a", "hash-b", "hash-c"]));
  });

  it("a consumed bond appears in the export, and an imported hash is spent here too", async () => {
    const container = createContainer("testnet");
    const first = await createMarket(container, req());
    if (first.status !== "payment_required") throw new Error("expected challenge");
    const proof = await container.payment.settle(first.requirement, "creator-1");
    const created = await createMarket(container, { ...req(), paymentProof: proof });
    expect(created.status).toBe("created");
    expect(exportConsumedBondPayments()).toContain(proof.deployHash);

    // A different instance's envelope names a hash this instance never saw — after import, a
    // creation presenting it is refused exactly as if it had been spent locally.
    __resetConsumedBonds();
    const challenge = await createMarket(container, req({ claim: "Will CSPR cross $0.15 by year end", target: "0.15" }));
    if (challenge.status !== "payment_required") throw new Error("expected challenge");
    const proof2 = await container.payment.settle(challenge.requirement, "creator-1");
    importConsumedBondPayments([proof2.deployHash]);
    const replay = await createMarket(container, {
      ...req({ claim: "Will CSPR cross $0.15 by year end", target: "0.15" }),
      paymentProof: proof2,
    });
    expect(replay.status).toBe("error");
    if (replay.status === "error") expect(replay.code).toBe(402);
  });
});

describe("created market runs create → bet → resolve → claim end to end", () => {
  it("settles a winner through the pure payout path", async () => {
    const container = createContainer("testnet");
    const created = await createWithBond(container, req());
    expect(created.status).toBe("created");
    if (created.status !== "created") return;

    const marketId = `testnet:${created.slug}`;
    // Bet on YES via the x402 rail.
    const challenge = await agentBet(container, { marketId, outcomeKey: "yes", amountMotes: "10000000000", bettor: "bettor-A" });
    expect(challenge.status).toBe("payment_required");
    if (challenge.status !== "payment_required") return;
    const proof = await container.payment.settle(challenge.requirement, "bettor-A");
    const placed = await agentBet(container, { marketId, outcomeKey: "yes", amountMotes: "10000000000", bettor: "bettor-A", paymentProof: proof });
    expect(placed.status).toBe("placed");

    // Resolve YES and confirm the settlement manifest pays the winner.
    const settlement = await container.store.settle(marketId, "yes");
    expect(settlement.status).toBe("resolved");
    expect(settlement.winningOutcomeKey).toBe("yes");
    expect(settlement.manifest).not.toBeNull();
    // The winner's claim is present and positive.
    const totalPaid = Object.values(settlement.manifest!.payouts).reduce((s, amt) => s + BigInt(amt), 0n);
    expect(totalPaid > 0n).toBe(true);
    expect(BigInt(settlement.manifest!.payouts["bettor-A"] ?? "0") > 0n).toBe(true);
  });
});

describe("creation economics", () => {
  /**
   * The bond is paid by a NATIVE CSPR transfer from the creator's wallet, and Casper's chainspec
   * rejects a native transfer below 2.5 CSPR (`native_transfer_minimum_motes`, a consensus rule).
   * The old 1 CSPR default was therefore unpayable: no proof could exist, so every real-mode
   * creation answered "invalid or unverifiable creation-bond payment". The default sits ON the
   * floor so the whole transferred amount is the bond — held, and refunded at clean settlement.
   */
  it("the default creation bond is payable by a native transfer", () => {
    delete process.env.CASPER_CREATION_BOND_MOTES;
    expect(creationBondMotes()).toBe("2500000000"); // 2.5 CSPR
    expect(BigInt(creationBondMotes())).toBeGreaterThanOrEqual(NATIVE_TRANSFER_MINIMUM_MOTES);
    expect(creationBondPaymentBlocker()).toBeNull();
  });

  it("an override below the transfer floor is named as an operator misconfiguration", () => {
    process.env.CASPER_CREATION_BOND_MOTES = "1000000000";
    expect(creationBondMotes()).toBe("1000000000");
    expect(creationBondPaymentBlocker()).toMatch(/native-transfer minimum/);
  });

  it("a bet preview on a freshly composed market is computable (cost estimate seam)", async () => {
    const container = createContainer("testnet");
    const created = await createWithBond(container, req());
    if (created.status !== "created") throw new Error("expected created");
    const market = await container.store.get(created.slug, "testnet");
    const preview = previewPayoutMotes(market!.poolByOutcomeMotes, "yes", "1000000000", market!.feeBps);
    expect(BigInt(preview) > 0n).toBe(true);
  });
});
