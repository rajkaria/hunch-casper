import { describe, it, expect } from "vitest";
import { createRealChain, realChainOptionsFromEnv, CasperConfigError } from "@/adapters/casper/real-chain";
import { runCasperChainContract } from "./contract/casper-chain.shared";

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
});
