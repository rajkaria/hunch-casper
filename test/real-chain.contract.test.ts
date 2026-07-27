import { describe, it, expect } from "vitest";
import { createRealChain, realChainOptionsFromEnv, CasperConfigError } from "@/adapters/casper/real-chain";
import { runCasperChainContract } from "./contract/casper-chain.shared";
import type { ExecutionOutcome } from "@/adapters/casper/confirm";

// The real adapter constructs safely without a funded key (keys are only read when a tx is
// actually submitted), so it can run the credential-free subset of the SAME contract the mock
// runs in full: correct network + explorer-URL shape. The submitting invariants need a funded
// testnet key + a live node, so they run out-of-band, not in CI (canSubmit: false).
runCasperChainContract(
  "real (credential-free subset)",
  (network) =>
    createRealChain(network, {
      bettorKey: "0".repeat(64),
      marketPackageHash: `hash-${"0".repeat(64)}`,
      proxyWasmPath: "/dev/null",
    }),
  { canSubmit: false, deterministic: false },
);

describe("realChainOptionsFromEnv", () => {
  it("throws a clear CasperConfigError when the signing key is absent", () => {
    const saved = process.env.CASPER_BETTOR_KEY;
    delete process.env.CASPER_BETTOR_KEY;
    try {
      expect(() => realChainOptionsFromEnv(`hash-${"0".repeat(64)}`)).toThrow(CasperConfigError);
      expect(() => realChainOptionsFromEnv(`hash-${"0".repeat(64)}`)).toThrow(/CASPER_BETTOR_KEY/);
    } finally {
      if (saved !== undefined) process.env.CASPER_BETTOR_KEY = saved;
    }
  });

  it("throws when neither a vault nor a per-market address map is configured", () => {
    const savedKey = process.env.CASPER_BETTOR_KEY;
    process.env.CASPER_BETTOR_KEY = "0".repeat(64);
    try {
      expect(() => realChainOptionsFromEnv(undefined)).toThrow(/no market contracts configured/);
    } finally {
      if (savedKey === undefined) delete process.env.CASPER_BETTOR_KEY;
      else process.env.CASPER_BETTOR_KEY = savedKey;
    }
  });

  it("accepts a per-market address map with no vault fallback (full-catalogue deploy)", () => {
    const savedKey = process.env.CASPER_BETTOR_KEY;
    process.env.CASPER_BETTOR_KEY = "0".repeat(64);
    try {
      const opts = realChainOptionsFromEnv(undefined, { "the-flip": `hash-${"a".repeat(64)}` });
      expect(opts.marketAddresses).toEqual({ "the-flip": `hash-${"a".repeat(64)}` });
    } finally {
      if (savedKey === undefined) delete process.env.CASPER_BETTOR_KEY;
      else process.env.CASPER_BETTOR_KEY = savedKey;
    }
  });

  it("accepts a v2 vault alone — the singleton IS the market config (S16)", () => {
    const savedKey = process.env.CASPER_BETTOR_KEY;
    process.env.CASPER_BETTOR_KEY = "0".repeat(64);
    try {
      const vaultV2 = `hash-${"c".repeat(64)}`;
      const opts = realChainOptionsFromEnv(undefined, undefined, vaultV2);
      expect(opts.vaultV2PackageHash).toBe(vaultV2);
      expect(opts.marketPackageHash).toBe("");
    } finally {
      if (savedKey === undefined) delete process.env.CASPER_BETTOR_KEY;
      else process.env.CASPER_BETTOR_KEY = savedKey;
    }
  });
});

/**
 * The unsigned bet — the self-custodial path.
 *
 * Building needs no key and no node, so the thing that actually matters can be asserted offline:
 * the transaction is initiated by the VISITOR (not the operator), and its hash is already known,
 * which is what lets `prepare` bind a ticket to it before any signature exists.
 */
describe("buildBetTransaction", () => {
  const BETTOR = "0186cd3a2b2c8bf1a8bcf1e6b0c1e0e5b2ef9f43d20a6a2b8a6a3f0c1d2e3f4a5b";

  const chain = createRealChain("testnet", {
    bettorKey: "0".repeat(64),
    marketPackageHash: `hash-${"0".repeat(64)}`,
    // The real proxy wasm: the transaction carries these bytes, so a placeholder would not be the
    // transaction the wallet is asked to sign.
    proxyWasmPath: "src/adapters/casper/resources/proxy_caller_with_return.wasm",
  });

  it("names the bettor as initiator — not the operator key", async () => {
    const unsigned = await chain.buildBetTransaction!({
      marketId: "will-it-rain",
      outcomeKey: "yes",
      amountMotes: "1000000000",
      bettor: BETTOR,
    });
    const json = JSON.parse(unsigned.transactionJson);
    expect(json.payload.initiator_addr.PublicKey).toBe(BETTOR);
    expect(json.payload.chain_name).toBe("casper-test");
    // Unsigned is the whole point: the wallet appends the approval.
    expect(json.approvals).toEqual([]);
  });

  it("knows the hash before the wallet signs, because approvals are not part of the payload", async () => {
    const unsigned = await chain.buildBetTransaction!({
      marketId: "will-it-rain",
      outcomeKey: "yes",
      amountMotes: "1000000000",
      bettor: BETTOR,
    });
    expect(unsigned.transactionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(unsigned.transactionJson).hash).toBe(unsigned.transactionHash);
  });

  it("carries the stake through the Odra proxy envelope, with amount === attached_value", async () => {
    // The money invariant. A direct package call would attach ZERO — a silent money bug — so the
    // wallet-signed path must use the same envelope the operator-signed one does.
    const unsigned = await chain.buildBetTransaction!({
      marketId: "will-it-rain",
      outcomeKey: "yes",
      amountMotes: "2500000000",
      bettor: BETTOR,
    });
    const args = JSON.parse(unsigned.transactionJson).payload.fields.args.Named as Array<
      [string, { bytes: string; cl_type: string }]
    >;
    const named = Object.fromEntries(args.map(([name, value]) => [name, value]));
    expect(Object.keys(named).sort()).toEqual([
      "amount",
      "args",
      "attached_value",
      "entry_point",
      "package_hash",
    ]);
    expect(named.amount.bytes).toBe(named.attached_value.bytes);
    expect(named.entry_point.cl_type).toBe("String");
    // Gas is the visitor's to pay, so the UI is told what it is.
    expect(unsigned.gasMotes).toMatch(/^\d+$/);
  });
});

/**
 * `checkTransaction` — the non-blocking confirmation seam.
 *
 * It exists so the visitor sees their transaction hash the moment a node has it, instead of after
 * the 8-16s the chain takes to execute. Every assertion here is that making it non-blocking did
 * NOT weaken what "confirmed" means: only an execution result the chain actually reports counts.
 */
describe("checkTransaction", () => {
  const HASH = "ab".repeat(32);
  const chainWith = (outcome: ExecutionOutcome) =>
    createRealChain("testnet", {
      bettorKey: "0".repeat(64),
      marketPackageHash: `hash-${"0".repeat(64)}`,
      proxyWasmPath: "/dev/null",
      confirmImpl: async () => outcome,
    });

  it("answers pending without waiting for the transaction to execute", async () => {
    expect(await chainWith({ state: "pending" }).checkTransaction!(HASH)).toEqual({ status: "pending" });
  });

  it("reports a confirmed execution with an explorer link to follow", async () => {
    const state = await chainWith({ state: "success" }).checkTransaction!(HASH);
    expect(state.status).toBe("confirmed");
    if (state.status !== "confirmed") throw new Error("unreachable");
    expect(state.result.deployHash).toBe(HASH);
    expect(state.result.explorerUrl).toContain(HASH);
  });

  it("reports a revert as reverted, carrying the chain's own message — never as confirmed", async () => {
    // The whole reason confirmation exists: a reverted escrow is not a bet, and indexing one puts
    // money on the boards that no vault is holding.
    expect(await chainWith({ state: "failure", error: "User error: 19" }).checkTransaction!(HASH)).toEqual({
      status: "reverted",
      error: "User error: 19",
    });
  });
});
