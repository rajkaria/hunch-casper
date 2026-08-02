/**
 * S30/W1 — the on-chain bettor is the agent that bet.
 *
 * The vault attributes a stake to `self.env().caller()`, which is the only impersonation-proof
 * choice. Before this sprint the adapter signed EVERY bet with the one operator key, so the vault
 * saw a single account for four Prophets and every human in operator custody: `stake_on` collapsed
 * to one bettor, the chain-fold leaderboard could only ever have one row, and per-agent reputation
 * was a number this server remembered rather than a fact anyone could recompute.
 *
 * These tests pin the fix and, just as importantly, its blast radius: only an `agent:<name>`
 * bettor on a deployment that actually holds that agent's key changes behaviour. Everything else
 * — humans, demo ids, and any deployment without a fleet seed — still signs exactly as before.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PrivateKey, KeyAlgorithm, type Transaction } from "casper-js-sdk";
import { createRealChain } from "@/adapters/casper/real-chain";
import { deriveAgentKeyHex } from "@/adapters/casper/fleet-keys";
import { createContainer } from "@/lib/container";
import { fleetBet, __resetConsumedNonces } from "@/lib/agent-bet";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import type { Container } from "@/lib/container";
import type { CasperChainPort, PlaceBetInput } from "@/ports/casper-chain";

beforeEach(() => {
  __resetLedger();
  __resetConsumedNonces();
});

const OPERATOR_KEY = "11".repeat(32);
const AGENT_KEY = "22".repeat(32);
const PROXY_WASM = "src/adapters/casper/resources/proxy_caller_with_return.wasm";

function publicKeyOf(secretHex: string): string {
  return PrivateKey.fromHex(secretHex, KeyAlgorithm.ED25519).publicKey.toHex();
}

/** A real adapter whose submit is intercepted, so a test can read back WHO signed. */
function chainCapturing(
  captured: { tx?: Transaction },
  agentKeyLookup?: (id: string) => string | null,
) {
  return createRealChain("testnet", {
    bettorKey: OPERATOR_KEY,
    marketPackageHash: `hash-${"0".repeat(64)}`,
    proxyWasmPath: PROXY_WASM,
    agentKeyLookup,
    submitImpl: async (tx) => {
      captured.tx = tx;
      return "ab".repeat(32);
    },
    confirmImpl: async () => ({ state: "success" }),
  });
}

function signerOf(captured: { tx?: Transaction }): string | undefined {
  return captured.tx?.approvals?.[0]?.signer?.toHex();
}

const BET: PlaceBetInput = {
  marketId: "btc-70k-nov",
  outcomeKey: "yes",
  amountMotes: "1000000000",
  bettor: "agent:momentum",
};

describe("who signs a bet", () => {
  it("a fleet agent signs its OWN escrow — the on-chain bettor is the agent that bet", async () => {
    const captured: { tx?: Transaction } = {};
    const chain = chainCapturing(captured, () => AGENT_KEY);

    await chain.placeBet(BET);

    expect(signerOf(captured)).toBe(publicKeyOf(AGENT_KEY));
    expect(signerOf(captured)).not.toBe(publicKeyOf(OPERATOR_KEY));
  });

  it("derives the agent key from CASPER_FLEET_SEED when no lookup is injected", async () => {
    const saved = process.env.CASPER_FLEET_SEED;
    process.env.CASPER_FLEET_SEED = "seed-for-this-test";
    try {
      const captured: { tx?: Transaction } = {};
      // No `agentKeyLookup` — this exercises the real `agentSecretKey` → `deriveAgentKeyHex` path,
      // which is the one production actually runs.
      const chain = chainCapturing(captured);

      await chain.placeBet(BET);

      const derived = deriveAgentKeyHex("seed-for-this-test", "agent:momentum");
      expect(signerOf(captured)).toBe(publicKeyOf(derived));
    } finally {
      if (saved === undefined) delete process.env.CASPER_FLEET_SEED;
      else process.env.CASPER_FLEET_SEED = saved;
    }
  });

  it("two different agents sign with two different accounts — reputation stays attributable", async () => {
    const seen = new Set<string>();
    for (const id of ["agent:momentum", "agent:contrarian", "agent:value", "agent:chaos"]) {
      const captured: { tx?: Transaction } = {};
      const chain = chainCapturing(captured, (agentId) => deriveAgentKeyHex("one-seed", agentId));
      await chain.placeBet({ ...BET, bettor: id });
      seen.add(signerOf(captured)!);
    }
    expect(seen.size).toBe(4);
  });

  it("falls back to the operator key when the deployment holds no key for the agent", async () => {
    const captured: { tx?: Transaction } = {};
    // `agentSecretKey` returns null with no seed and no per-agent override — the pre-S30 behaviour,
    // which must stay byte-identical so an unconfigured deployment is unaffected by this sprint.
    const chain = chainCapturing(captured, () => null);

    await chain.placeBet(BET);

    expect(signerOf(captured)).toBe(publicKeyOf(OPERATOR_KEY));
  });

  it("keeps operator custody for a human bettor named by public key", async () => {
    const captured: { tx?: Transaction } = {};
    const chain = chainCapturing(captured, () => AGENT_KEY);

    await chain.placeBet({ ...BET, bettor: publicKeyOf("33".repeat(32)) });

    expect(signerOf(captured)).toBe(publicKeyOf(OPERATOR_KEY));
  });

  it("keeps operator custody for an opaque id — an unknown string must never mint a signer", async () => {
    const captured: { tx?: Transaction } = {};
    // The dangerous direction: deriving a key for any string would sign from an unfunded purse and,
    // worse, let a caller name a purse that is not theirs.
    const chain = chainCapturing(captured, (id) => (id === "agent:momentum" ? AGENT_KEY : null));

    await chain.placeBet({ ...BET, bettor: "demo-4f21" });

    expect(signerOf(captured)).toBe(publicKeyOf(OPERATOR_KEY));
  });

  it("submitBet resolves the signer exactly as placeBet does — the two must not diverge", async () => {
    const captured: { tx?: Transaction } = {};
    const chain = chainCapturing(captured, () => AGENT_KEY);

    await chain.submitBet!(BET);

    expect(signerOf(captured)).toBe(publicKeyOf(AGENT_KEY));
  });
});

describe("canSelfSign", () => {
  const chain = () => chainCapturing({}, (id) => (id.startsWith("agent:") ? AGENT_KEY : null));

  it("is true for a fleet agent whose key this deployment holds", () => {
    expect(chain().canSelfSign!("agent:momentum")).toBe(true);
  });

  it("is false for a human public key", () => {
    expect(chain().canSelfSign!(publicKeyOf("33".repeat(32)))).toBe(false);
  });

  it("is false for an opaque id", () => {
    expect(chain().canSelfSign!("demo-4f21")).toBe(false);
  });

  it("is false for a fleet agent when no key is configured", () => {
    expect(chainCapturing({}, () => null).canSelfSign!("agent:momentum")).toBe(false);
  });
});

describe("fleetBet — self-custodial placement", () => {
  /** A container whose chain self-signs for the fleet and records what it was asked to place. */
  function selfSigningContainer(placed: PlaceBetInput[]): Container {
    const base = createContainer("testnet");
    const chain: CasperChainPort = {
      ...base.chain,
      canSelfSign: (bettor: string) => bettor.startsWith("agent:"),
      placeBet: async (input: PlaceBetInput) => {
        placed.push(input);
        return { deployHash: "escrow-tx-1", explorerUrl: "https://testnet.cspr.live/transaction/escrow-tx-1" };
      },
    };
    return { ...base, chain };
  }

  it("places without any payment proof — the escrow IS the settlement", async () => {
    const placed: PlaceBetInput[] = [];
    const res = await fleetBet(selfSigningContainer(placed), {
      marketId: "testnet:btc-70k-nov",
      outcomeKey: "yes",
      amountMotes: "1000000000",
      bettor: "agent:momentum",
    });

    expect(res.status).toBe("placed");
    expect(placed).toHaveLength(1);
    expect(placed[0].bettor).toBe("agent:momentum");
    if (res.status === "placed") expect(res.proof.deployHash).toBe("escrow-tx-1");
  });

  it("does NOT charge the agent a second time — no x402 transfer accompanies the escrow", async () => {
    const placed: PlaceBetInput[] = [];
    const container = selfSigningContainer(placed);
    let transfers = 0;
    const wallet = { ...container.wallet, transfer: async () => { transfers++; throw new Error("unreachable"); } };

    const res = await fleetBet({ ...container, wallet } as Container, {
      marketId: "testnet:btc-70k-nov",
      outcomeKey: "yes",
      amountMotes: "1000000000",
      bettor: "agent:momentum",
    });

    expect(res.status).toBe("placed");
    // The whole point: the stake moved once, into the vault. Reimbursing an operator that never
    // fronted anything would take it twice.
    expect(transfers).toBe(0);
  });

  it("refuses a bettor the deployment cannot sign for — 'I am agent:x' is not assertable", async () => {
    const placed: PlaceBetInput[] = [];
    const container = selfSigningContainer(placed);
    const chain: CasperChainPort = { ...container.chain, canSelfSign: () => false };

    const res = await fleetBet({ ...container, chain }, {
      marketId: "testnet:btc-70k-nov",
      outcomeKey: "yes",
      amountMotes: "1000000000",
      bettor: "agent:momentum",
    });

    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe(403);
    expect(placed).toHaveLength(0);
  });

  it("still enforces every shared guard — an unknown market is rejected before any escrow", async () => {
    const placed: PlaceBetInput[] = [];
    const res = await fleetBet(selfSigningContainer(placed), {
      marketId: "testnet:no-such-market",
      outcomeKey: "yes",
      amountMotes: "1000000000",
      bettor: "agent:momentum",
    });

    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe(400);
    expect(placed).toHaveLength(0);
  });

  it("still enforces the outcome guard", async () => {
    const placed: PlaceBetInput[] = [];
    const res = await fleetBet(selfSigningContainer(placed), {
      marketId: "testnet:btc-70k-nov",
      outcomeKey: "not-an-outcome",
      amountMotes: "1000000000",
      bettor: "agent:momentum",
    });

    expect(res.status).toBe("error");
    expect(placed).toHaveLength(0);
  });
});

/**
 * The double-charge regression, pinned at the level where it would actually have happened.
 *
 * `runProphet` used to do two things in sequence: transfer the stake to the operator treasury over
 * x402, then have the operator escrow the same stake into the vault. That second step is now the
 * agent's own signed transaction — so if the first step were left in place, one bet would cost the
 * agent its stake twice: once into the vault, once into the treasury.
 */
describe("runProphet under self-custody", () => {
  it("escrows once and transfers nothing — the reimbursement leg is gone, not duplicated", async () => {
    const { runProphet } = await import("@/agent/prophet");
    const { PROPHETS } = await import("@/core/prophet-strategies");
    const { __resetActivity } = await import("@/adapters/mock/activity-log");
    __resetActivity();

    const base = createContainer("testnet");
    const transfers: unknown[] = [];
    const placed: PlaceBetInput[] = [];

    const container: Container = {
      ...base,
      wallet: {
        ...base.wallet,
        transfer: async (input) => {
          transfers.push(input);
          return { deployHash: "should-not-happen", explorerUrl: "" };
        },
      },
      chain: {
        ...base.chain,
        canSelfSign: (bettor: string) => bettor.startsWith("agent:"),
        placeBet: async (input: PlaceBetInput) => {
          placed.push(input);
          return { deployHash: "escrow-tx", explorerUrl: "https://testnet.cspr.live/transaction/escrow-tx" };
        },
      },
    };

    const open = (await container.store.list({ network: "testnet", status: "open" })).filter(
      (m) => m.category !== "meta",
    );
    const action = await runProphet(container, PROPHETS[0], open[0].slug, 0);

    expect(action).not.toBeNull();
    expect(placed).toHaveLength(1);
    expect(placed[0].bettor).toBe(PROPHETS[0].id);
    expect(transfers).toHaveLength(0);
  });

  it("still runs the x402 reimbursement leg when the deployment cannot self-sign", async () => {
    const { runProphet } = await import("@/agent/prophet");
    const { PROPHETS } = await import("@/core/prophet-strategies");
    const { __resetActivity } = await import("@/adapters/mock/activity-log");
    __resetActivity();

    const base = createContainer("testnet");
    const transfers: unknown[] = [];
    const container: Container = {
      ...base,
      wallet: {
        ...base.wallet,
        transfer: async (input) => {
          transfers.push(input);
          return base.wallet.transfer(input);
        },
      },
      // No `canSelfSign` at all — exactly what the mock adapter and an unseeded deployment look
      // like. The pre-S30 path must be untouched.
      chain: { ...base.chain },
    };

    const open = (await container.store.list({ network: "testnet", status: "open" })).filter(
      (m) => m.category !== "meta",
    );
    const action = await runProphet(container, PROPHETS[0], open[0].slug, 0);

    expect(action).not.toBeNull();
    expect(transfers).toHaveLength(1);
  });
});
