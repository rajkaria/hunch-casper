/**
 * Public claims must survive a reader who checks.
 *
 * README.md and VISION.md are what a judge, a grant reviewer and a Casper developer read first,
 * and they are the files least likely to be re-read by anyone who changes the code. Twice in this
 * repository's history they described contracts that were compiled but not deployed as though they
 * were live. These tests make the specific claims that were wrong assertable against the tree.
 *
 * Deliberately narrow: this cannot check that prose is true in general, only that the handful of
 * claims with a mechanical counterpart still line up with it.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** Contracts with a deployed address and a caller in `src/`. */
const DEPLOYED = ["HunchVault", "ParimutuelMarket", "MarketFactory", "OracleRegistry", "FieldMarket"];
/** Contracts that compile and are tested but have no deployment and no caller. */
const REFERENCE_ONLY = ["DisputePanel", "LmsrMarket", "CopyBetting"];

describe("README does not present undeployed contracts as live", () => {
  it("labels the three off-chain-implemented contracts as reference only", async () => {
    const readme = await read("README.md");
    expect(readme).toMatch(/reference contracts, not deployed/i);
    for (const name of REFERENCE_ONLY) {
      expect(readme).toContain(name);
    }
  });

  it("still names every genuinely deployed contract", async () => {
    const readme = await read("README.md");
    for (const name of DEPLOYED) expect(readme).toContain(name);
  });

  it("points at the off-chain modules that actually implement the reference three", async () => {
    const readme = await read("README.md");
    // If someone deploys them for real, these pointers are what they must come back and remove.
    expect(readme).toContain("core/lmsr.ts");
    expect(readme).toContain("agent/dispute-flow.ts");
  });
});

describe("the reference-only claim is true of the tree", () => {
  it.each(REFERENCE_ONLY)("%s has no address slot in the network config", async (name) => {
    const network = await read("src/config/network.ts");
    // An address slot is what makes a contract reachable; absence is the mechanical form of
    // "not deployed", and it is what these tests actually verify.
    const slot = name.charAt(0).toLowerCase() + name.slice(1);
    expect(network).not.toContain(`${slot}: envAddr(`);
  });

  it("the contracts that ARE claimed deployed all have address slots", async () => {
    const network = await read("src/config/network.ts");
    for (const slot of ["vaultV2", "fieldMarket", "marketFactory", "oracleRegistry", "agentRegistry", "resolutionHook"]) {
      expect(network).toContain(`${slot}: envAddr(`);
    }
  });
});

describe("test counts quoted in the README are not stale", () => {
  it("quotes an OdraVM count that matches the contracts' own #[test] count", async () => {
    const readme = await read("README.md");
    const quoted = readme.match(/(\d+) OdraVM tests/);
    expect(quoted).not.toBeNull();

    const { readdir } = await import("node:fs/promises");
    const dir = new URL("../contracts/src/", import.meta.url);
    let actual = 0;
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".rs")) continue;
      actual += (await readFile(new URL(file, dir), "utf8")).split("#[test]").length - 1;
    }
    expect(Number(quoted![1])).toBe(actual);
  });
});

describe("VISION does not claim shipped for anything unreachable", () => {
  it("backs its AgentRegistry and ResolutionHook claims with deployed package hashes", async () => {
    const vision = await read("VISION.md");
    // Both were described as "shipped" while having no deployment at all.
    expect(vision).toMatch(/hash-e226e709/);
    expect(vision).toMatch(/hash-35e2443b/);
  });
});

describe("the operator runbook matches the custody model the code implements", () => {
  it("documents both custody modes rather than only the retired one", async () => {
    const ops = await read("docs/OPS.md");
    expect(ops).toMatch(/Self-custodial/i);
    expect(ops).toMatch(/Operator custody/i);
    // The pre-S30 doc warned against the very design that shipped; that warning must be gone.
    expect(ops).not.toMatch(/would\s+charge the agent twice/i);
  });
});
