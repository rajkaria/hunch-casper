/**
 * The real fleet wallet against the shared `WalletPort` contract, plus the behaviours only it
 * has: key derivation, the balance read, and what happens when neither is configured.
 *
 * `transfer` is excluded from the shared suite — submitting one needs a funded key and a live
 * node, which CI does not have. Everything up to the submit seam is still asserted here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRealWallet, FleetWalletError, TRANSFER_PAYMENT_MOTES } from "@/adapters/casper/real-wallet";
import {
  agentKeyEnvName,
  agentSecretKey,
  deriveAgentKeyHex,
  fleetConfigured,
  FleetKeyError,
  parseBalanceResult,
} from "@/adapters/casper/fleet-keys";
import { NATIVE_TRANSFER_MINIMUM_MOTES } from "@/config/network";
import { runWalletContract } from "./contract/wallet.shared";

const SEED = "ocean-test-fleet-seed-do-not-use-in-production";

describe("fleet key derivation", () => {
  it("is deterministic — the same seed and agent always derive the same key", () => {
    expect(deriveAgentKeyHex(SEED, "agent:momentum")).toBe(deriveAgentKeyHex(SEED, "agent:momentum"));
  });

  it("derives a 32-byte hex key", () => {
    expect(deriveAgentKeyHex(SEED, "agent:momentum")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives every agent a different key — the whole point of per-agent identity", () => {
    const keys = ["agent:momentum", "agent:contrarian", "agent:value", "agent:chaos"].map((a) =>
      deriveAgentKeyHex(SEED, a),
    );
    expect(new Set(keys).size).toBe(4);
  });

  it("is case- and whitespace-insensitive on the agent id, so one agent never gets two wallets", () => {
    expect(deriveAgentKeyHex(SEED, "  Agent:Momentum ")).toBe(deriveAgentKeyHex(SEED, "agent:momentum"));
  });

  it("changes completely with the seed — a rotated seed is a new fleet", () => {
    expect(deriveAgentKeyHex(SEED, "agent:momentum")).not.toBe(
      deriveAgentKeyHex(SEED + "x", "agent:momentum"),
    );
  });

  it("rejects an empty seed or agent id rather than deriving a predictable key", () => {
    expect(() => deriveAgentKeyHex("   ", "agent:momentum")).toThrow(FleetKeyError);
    expect(() => deriveAgentKeyHex(SEED, "  ")).toThrow(FleetKeyError);
  });
});

describe("agent key resolution", () => {
  it("names the per-agent override variable predictably", () => {
    expect(agentKeyEnvName("agent:momentum")).toBe("CASPER_PROPHET_KEY_AGENT_MOMENTUM");
  });

  it("prefers an explicit per-agent key over the derived one", () => {
    const env = { CASPER_FLEET_SEED: SEED, CASPER_PROPHET_KEY_AGENT_MOMENTUM: "ab".repeat(32) };
    expect(agentSecretKey("agent:momentum", env)).toBe("ab".repeat(32));
    // Its sibling still derives from the seed.
    expect(agentSecretKey("agent:chaos", env)).toBe(deriveAgentKeyHex(SEED, "agent:chaos"));
  });

  it("returns null when nothing is configured, so the caller decides whether that is fatal", () => {
    expect(agentSecretKey("agent:momentum", {})).toBeNull();
    expect(fleetConfigured({})).toBe(false);
    expect(fleetConfigured({ CASPER_FLEET_SEED: "   " })).toBe(false);
    expect(fleetConfigured({ CASPER_FLEET_SEED: SEED })).toBe(true);
  });
});

describe("parseBalanceResult", () => {
  it("reads a motes string from a well-formed result", () => {
    expect(parseBalanceResult({ result: { balance: "123456789" } })).toBe("123456789");
  });

  it("accepts a numeric balance", () => {
    expect(parseBalanceResult({ result: { balance: 42 } })).toBe("42");
  });

  it("returns null — not zero — for anything it cannot read", () => {
    // "Unknown" and "empty" lead an operator to different actions; conflating them is the bug.
    expect(parseBalanceResult(null)).toBeNull();
    expect(parseBalanceResult({ error: { code: -32602 } })).toBeNull();
    expect(parseBalanceResult({ result: {} })).toBeNull();
    expect(parseBalanceResult({ result: { balance: "not-a-number" } })).toBeNull();
    expect(parseBalanceResult({ result: { balance: -1 } })).toBeNull();
  });
});

describe("real wallet without key material", () => {
  it("names the two ways to fix it rather than failing opaquely", async () => {
    const wallet = createRealWallet("testnet");
    await expect(wallet.accountFor("agent:momentum")).rejects.toThrow(FleetWalletError);
    await expect(wallet.accountFor("agent:momentum")).rejects.toThrow(/CASPER_FLEET_SEED/);
  });
});

describe("real wallet balance read", () => {
  beforeEach(() => {
    vi.stubEnv("CASPER_FLEET_SEED", SEED);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("queries the agent's main purse by its derived public key", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe("query_balance");
      expect(body.params.purse_identifier.main_purse_under_public_key).toMatch(/^01[0-9a-f]{64}$/);
      return new Response(JSON.stringify({ result: { balance: "7000000000" } }), { status: 200 });
    });
    const wallet = createRealWallet("testnet", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await wallet.balanceOf("agent:momentum")).toBe("7000000000");
  });

  it("reads an unfunded (non-existent) account as zero, not as an error", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: -32003, message: "purse not found" } }), { status: 200 }),
    );
    const wallet = createRealWallet("testnet", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await wallet.balanceOf("agent:momentum")).toBe("0");
  });

  it("reads zero when the node is unreachable, so the agent sits out instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const wallet = createRealWallet("testnet", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await wallet.balanceOf("agent:momentum")).toBe("0");
  });
});

describe("real wallet transfer construction", () => {
  beforeEach(() => {
    vi.stubEnv("CASPER_FLEET_SEED", SEED);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds and signs a native transfer from the agent's own key", async () => {
    let signed = false;
    const wallet = createRealWallet("testnet", {
      submitImpl: async (tx, key) => {
        tx.sign(key);
        signed = true;
        return "ab".repeat(32);
      },
      confirmImpl: async () => ({ state: "success" }),
    });
    const account = await wallet.accountFor("agent:momentum");
    const res = await wallet.transfer({
      agentId: "agent:momentum",
      toAccount: "01" + "cd".repeat(32),
      amountMotes: "3000000000",
    });
    expect(signed).toBe(true);
    expect(res.deployHash).toBe("ab".repeat(32));
    expect(res.explorerUrl).toBe(`https://testnet.cspr.live/transaction/${"ab".repeat(32)}`);
    // The signer is the agent's derived identity, not the operator key.
    expect(account.publicKeyHex).toMatch(/^01[0-9a-f]{64}$/);
  });

  it("accepts an account-hash recipient as well as a public key", async () => {
    const wallet = createRealWallet("testnet", {
      submitImpl: async () => "cd".repeat(32),
      confirmImpl: async () => ({ state: "success" }),
    });
    const res = await wallet.transfer({
      agentId: "agent:momentum",
      toAccount: "account-hash-" + "ef".repeat(32),
      amountMotes: "3000000000",
    });
    expect(res.deployHash).toBe("cd".repeat(32));
  });

  it("refuses a non-positive amount before building anything", async () => {
    const wallet = createRealWallet("testnet", { submitImpl: async () => "00".repeat(32) });
    await expect(
      wallet.transfer({ agentId: "agent:momentum", toAccount: "01" + "cd".repeat(32), amountMotes: "0" }),
    ).rejects.toThrow(FleetWalletError);
  });

  it("prices the transfer at the native-transfer limit", () => {
    expect(TRANSFER_PAYMENT_MOTES).toBe(100_000_000);
  });
});

describe("real wallet transfer — the chainspec native-transfer floor", () => {
  beforeEach(() => {
    vi.stubEnv("CASPER_FLEET_SEED", SEED);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a sub-minimum transfer BEFORE submitting, naming the rule", async () => {
    // Three of the four Prophets staked 1–2 CSPR against a 2.5 CSPR consensus floor. The node
    // answered `-32016 insufficient transfer amount` and the fleet looked idle rather than broken.
    let submitted = false;
    const wallet = createRealWallet("testnet", {
      submitImpl: async () => {
        submitted = true;
        return "ab".repeat(32);
      },
      confirmImpl: async () => ({ state: "success" }),
    });
    const tooSmall = wallet.transfer({
      agentId: "agent:momentum",
      toAccount: "01" + "cd".repeat(32),
      amountMotes: (NATIVE_TRANSFER_MINIMUM_MOTES - 1n).toString(),
    });
    await expect(tooSmall).rejects.toThrow(FleetWalletError);
    await expect(tooSmall).rejects.toThrow(/native-transfer minimum/);
    expect(submitted).toBe(false);
  });

  it("allows a transfer exactly at the floor", async () => {
    const wallet = createRealWallet("testnet", {
      submitImpl: async () => "ab".repeat(32),
      confirmImpl: async () => ({ state: "success" }),
    });
    const res = await wallet.transfer({
      agentId: "agent:momentum",
      toAccount: "01" + "cd".repeat(32),
      amountMotes: NATIVE_TRANSFER_MINIMUM_MOTES.toString(),
    });
    expect(res.deployHash).toBe("ab".repeat(32));
  });
});

describe("real wallet transfer — confirmation before it counts as a payment", () => {
  beforeEach(() => {
    vi.stubEnv("CASPER_FLEET_SEED", SEED);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not return a proof until the chain has EXECUTED the transfer — THE regression", async () => {
    // The bug: transfer resolved on `putTransaction` (queued), the verifier then found no
    // execution result and rejected the proof — after 3 CSPR had already left the purse.
    const order: string[] = [];
    const wallet = createRealWallet("testnet", {
      submitImpl: async () => {
        order.push("submit");
        return "ab".repeat(32);
      },
      confirmImpl: async () => {
        order.push("confirm");
        return { state: "success" };
      },
    });
    await wallet.transfer({
      agentId: "agent:momentum",
      toAccount: "01" + "cd".repeat(32),
      amountMotes: "3000000000",
    });
    expect(order).toEqual(["submit", "confirm"]);
  });

  it("throws instead of returning a proof when the transfer reverted", async () => {
    const wallet = createRealWallet("testnet", {
      submitImpl: async () => "ab".repeat(32),
      confirmImpl: async () => ({ state: "failure", error: "insufficient balance" }),
    });
    await expect(
      wallet.transfer({ agentId: "agent:momentum", toAccount: "01" + "cd".repeat(32), amountMotes: "3000000000" }),
    ).rejects.toThrow(/REVERTED/);
  });

  it("throws — and points at the explorer — when execution does not land in the window", async () => {
    const wallet = createRealWallet("testnet", {
      submitImpl: async () => "ab".repeat(32),
      confirmImpl: async () => ({ state: "pending" }),
    });
    const pending = wallet.transfer({
      agentId: "agent:momentum",
      toAccount: "01" + "cd".repeat(32),
      amountMotes: "3000000000",
    });
    await expect(pending).rejects.toThrow(FleetWalletError);
    await expect(pending).rejects.toThrow(/testnet\.cspr\.live\/transaction\//);
  });
});

// The credential-free subset of the shared contract: identity and balances work with a seed,
// transfers need a funded key and a live node, so they stay out.
describe("real wallet — shared contract subset", () => {
  beforeEach(() => {
    vi.stubEnv("CASPER_FLEET_SEED", SEED);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  runWalletContract(
    "real",
    (network) =>
      createRealWallet(network, {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ result: { balance: "5000000000" } }), {
            status: 200,
          })) as unknown as typeof fetch,
      }),
    { canTransfer: false, agentId: "agent:momentum" },
  );
});
