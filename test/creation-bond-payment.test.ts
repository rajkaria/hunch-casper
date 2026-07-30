/**
 * The creation bond's money path, end to end — the regression suite for "invalid or unverifiable
 * creation-bond payment".
 *
 * The bug had three layers, and each one is pinned here because any of them alone brings the whole
 * page back:
 *
 *  1. The create page fabricated a `demo-<nonce>-…` settlement id. The transfer-verifying
 *     `PaymentPort` (real mode + `CASPER_X402_PAYTO`, which is production) requires a 64-hex
 *     on-chain transaction, so it rejected every bond before touching the network.
 *  2. The bond was 1 CSPR — BELOW Casper's `native_transfer_minimum_motes` (2.5 CSPR, a consensus
 *     rule). Even a wired-up wallet could not have paid it: the node rejects the transfer.
 *  3. The oracle field defaulted to `account-hash-arbiter`, which `Key::newKey` cannot parse — so
 *     a correctly paid bond would then have died building the `create_market` transaction.
 *
 * The last test closes the loop: the transaction this code now builds is one the verifier accepts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { POST as bondPOST, GET as bondGET } from "@/app/api/markets/create/bond/route";
import { GET as termsGET } from "@/app/api/markets/create/route";
import { createMarket, creationBondMotes, __resetConsumedBonds } from "@/lib/market-create";
import { createContainer } from "@/lib/container";
import { createRealPayment, verifyTransferResult } from "@/adapters/casper/real-payment";
import { toOracleAddress } from "@/adapters/casper/real-chain";
import { NATIVE_TRANSFER_MINIMUM_MOTES } from "@/config/network";
import type { CreateMarketRequest } from "@/lib/market-create";
import type { X402PaymentProof, X402PaymentRequirement } from "@/ports/payment";

const CREATOR = `01${"aa".repeat(32)}`; // a real, signable public key
const TREASURY = `01${"bb".repeat(32)}`; // CASPER_X402_PAYTO
const ORACLE = `account-hash-${"cc".repeat(32)}`;
/** A second real key, so the approved oracle can be named in either of its two spellings. */
const ORACLE_PUBKEY = `01${"cd".repeat(32)}`;

afterEach(() => {
  vi.unstubAllEnvs();
  __resetConsumedBonds();
});

function req(over: Partial<CreateMarketRequest> = {}): CreateMarketRequest {
  return {
    claim: "Will CSPR cross $0.10 by year end",
    creator: CREATOR,
    oracle: ORACLE,
    network: "testnet",
    seq: 0,
    // Relative, not a fixed date: real mode now enforces the vault's future-and-within-180-days
    // horizon before the bond, so a hardcoded deadline would rot as the calendar passes it.
    deadlineIso: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
    source: "coingecko",
    metric: "cspr_usd",
    method: "threshold",
    target: "0.10",
    comparator: "gte",
    seedByFleet: false,
    ...over,
  };
}

function post(url: string, body: unknown) {
  return bondPOST(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** Real mode with the transfer-verifying rail wired — production's configuration. The approved
 * oracle is part of that configuration now: real-mode creation refuses to bind any other. */
function realModeWithTreasury(): void {
  vi.stubEnv("CASPER_CHAIN_MODE", "real");
  vi.stubEnv("CASPER_X402_PAYTO", TREASURY);
  vi.stubEnv("CASPER_ORACLE_ACCOUNT", ORACLE);
}

describe("the bug: a fabricated bond proof can never settle the real rail", () => {
  it("the real PaymentPort rejects the page's old `demo-…` settlement id without asking a node", async () => {
    // The exact proof `demoProof()` used to send. It never reached the RPC — which is why the
    // failure was instant, total, and identical for every visitor.
    const fetchImpl = vi.fn();
    const payment = createRealPayment("testnet", TREASURY, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const requirement = await payment.quote({
      marketId: "user-market-0",
      outcomeKey: "__bond__",
      amountMotes: creationBondMotes(),
      payer: CREATOR,
    });
    const bogus: X402PaymentProof = {
      scheme: "casper-x402",
      deployHash: `demo-${requirement.nonce}-0123456789abcdef01234567`,
      nonce: requirement.nonce,
    };
    expect(await payment.verify(requirement, bogus)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces as a 402 on the create route, so the whole page was unusable in production", async () => {
    realModeWithTreasury();
    const container = createContainer("testnet");
    const challenge = await createMarket(container, req());
    if (challenge.status !== "payment_required") throw new Error("expected a bond challenge");
    const res = await createMarket(container, {
      ...req(),
      paymentProof: {
        scheme: "casper-x402",
        deployHash: `demo-${challenge.requirement.nonce}-0123456789abcdef01234567`,
        nonce: challenge.requirement.nonce,
      },
    });
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe(402);
      expect(res.error).toMatch(/unverifiable creation-bond payment/);
    }
  });
});

describe("the bond is payable at all", () => {
  it("the default sits on Casper's native-transfer floor, so a wallet can actually send it", () => {
    expect(BigInt(creationBondMotes())).toBeGreaterThanOrEqual(NATIVE_TRANSFER_MINIMUM_MOTES);
  });

  it("a sub-floor override is refused by the bond route rather than failing inside a wallet", async () => {
    realModeWithTreasury();
    vi.stubEnv("CASPER_CREATION_BOND_MOTES", "1000000000"); // the old, unpayable default
    const res = await post("http://localhost/api/markets/create/bond", {
      network: "testnet",
      creator: CREATOR,
    });
    // 503, not 400: nothing the visitor typed is wrong.
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/native-transfer minimum/);
  });
});

describe("POST /api/markets/create/bond", () => {
  it("tells a simulated deployment to settle the bond off-chain (501, not a failure)", async () => {
    // The default test container is the mock chain — there is no transfer to build, and the page
    // reads 501 as "use the deterministic proof", exactly as the bet panel does.
    const res = await post("http://localhost/api/markets/create/bond", {
      network: "testnet",
      creator: CREATOR,
    });
    expect(res.status).toBe(501);
    expect((await res.json()).error).toMatch(/simulated chain|cannot build/i);
  });

  it("refuses a creator that is not a key anyone can sign with", async () => {
    const res = await post("http://localhost/api/markets/create/bond", {
      network: "testnet",
      creator: "demo-creator", // what the page used to send for everyone
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/public key/i);
  });

  it("refuses a network it does not serve", async () => {
    const res = await post("http://localhost/api/markets/create/bond", {
      network: "regtest",
      creator: CREATOR,
    });
    expect(res.status).toBe(400);
  });

  it("only answers GET for a real transaction hash", async () => {
    const res = await bondGET(
      new Request("http://localhost/api/markets/create/bond?network=testnet&hash=demo-nope"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/transaction hash/i);
  });
});

describe("the two identities that must be real before the bond is quoted", () => {
  it("rejects `demo-creator` up front instead of taking a bond that could never verify", async () => {
    realModeWithTreasury();
    const container = createContainer("testnet");
    const res = await createMarket(container, req({ creator: "demo-creator" }));
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe(400);
      expect(res.error).toMatch(/connect a Casper wallet/i);
    }
  });

  it("rejects the `account-hash-arbiter` placeholder the form shipped with", async () => {
    // `Key::newKey` cannot parse it, so this used to throw while building the transaction — after
    // the bond had been paid. A 400 before the challenge is the difference.
    realModeWithTreasury();
    const container = createContainer("testnet");
    const res = await createMarket(container, req({ oracle: "account-hash-arbiter" }));
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe(400);
      expect(res.error).toMatch(/account-hash-<64 hex>/);
    }
  });

  it("leaves the mock deployment's friendly labels alone — nothing there reaches a chain", async () => {
    const container = createContainer("testnet");
    const res = await createMarket(container, req({ creator: "demo-creator", oracle: "account-hash-arbiter" }));
    expect(res.status).toBe("payment_required");
  });
});

/**
 * The oracle is the account that decides who gets paid — and on this deployment `create_market`
 * is submitted by the operator key, which is the vault ADMIN, so every one of the contract's
 * public-creation guardrails (SelfOracle, OracleNotApproved) is skipped. These tests pin the
 * app-side enforcement that replaces them: the submitted oracle must RESOLVE to the deployment's
 * approved oracle, compared as accounts (public key ⇄ account-hash, case-insensitive), never as
 * raw strings.
 */
describe("real mode binds only the deployment's approved oracle", () => {
  it("rejects a creator smuggling their OWN account-hash as the oracle", async () => {
    // The creator field is a public key; its account-hash is a different byte string, so the old
    // raw comparison passed — and the creator became the oracle of a market they can bet in.
    realModeWithTreasury();
    const container = createContainer("testnet");
    const res = await createMarket(container, req({ oracle: toOracleAddress(CREATOR) }));
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe(400);
      expect(res.error).toMatch(/own oracle/);
    }
  });

  it("rejects a case-flipped spelling of the creator's account-hash", async () => {
    realModeWithTreasury();
    const container = createContainer("testnet");
    const selfHash = toOracleAddress(CREATOR);
    const flipped = `account-hash-${selfHash.replace(/^account-hash-/, "").toUpperCase()}`;
    const res = await createMarket(container, req({ oracle: flipped }));
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe(400);
      expect(res.error).toMatch(/own oracle/);
    }
  });

  it("rejects any well-formed oracle that is not the approved one", async () => {
    realModeWithTreasury();
    const container = createContainer("testnet");
    const res = await createMarket(container, req({ oracle: `account-hash-${"dd".repeat(32)}` }));
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe(400);
      expect(res.error).toMatch(/approved oracle/);
    }
  });

  it("accepts the approved oracle in its account-hash form (case-insensitively)", async () => {
    realModeWithTreasury();
    const container = createContainer("testnet");
    expect((await createMarket(container, req())).status).toBe("payment_required");
    const flipped = `account-hash-${"CC".repeat(32)}`;
    expect((await createMarket(container, req({ oracle: flipped }))).status).toBe("payment_required");
  });

  it("accepts the approved oracle as a public key when the config holds its account-hash", async () => {
    realModeWithTreasury();
    vi.stubEnv("CASPER_ORACLE_ACCOUNT", toOracleAddress(ORACLE_PUBKEY));
    const container = createContainer("testnet");
    const res = await createMarket(container, req({ oracle: ORACLE_PUBKEY }));
    expect(res.status).toBe("payment_required");
  });

  it("accepts the approved oracle as an account-hash when the config holds the public key", async () => {
    realModeWithTreasury();
    vi.stubEnv("CASPER_ORACLE_ACCOUNT", ORACLE_PUBKEY);
    const container = createContainer("testnet");
    const res = await createMarket(container, req({ oracle: toOracleAddress(ORACLE_PUBKEY) }));
    expect(res.status).toBe("payment_required");
  });

  it("503s when no approved oracle is configured, instead of binding whatever was typed", async () => {
    realModeWithTreasury();
    vi.stubEnv("CASPER_ORACLE_ACCOUNT", "");
    const container = createContainer("testnet");
    const res = await createMarket(container, req());
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe(503);
      expect(res.error).toMatch(/CASPER_ORACLE_ACCOUNT/);
    }
  });
});

/**
 * The vault's deadline rules never run for the admin key either, so the app enforces them before
 * anyone pays: a past (or unparseable) deadline opens a market that can never be bet, and a
 * years-out one escrows bettor funds far beyond the contract's own public horizon.
 */
describe("the deadline is validated before the bond challenge", () => {
  it("rejects a deadline in the past", async () => {
    realModeWithTreasury();
    const container = createContainer("testnet");
    const res = await createMarket(container, req({ deadlineIso: new Date(Date.now() - 3_600_000).toISOString() }));
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe(400);
      expect(res.error).toMatch(/future/);
    }
  });

  it("rejects an unparseable deadline with the same clean 400", async () => {
    realModeWithTreasury();
    const container = createContainer("testnet");
    const res = await createMarket(container, req({ deadlineIso: "not-a-date" }));
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.code).toBe(400);
  });

  it("rejects a deadline beyond the vault's 180-day public horizon", async () => {
    realModeWithTreasury();
    const container = createContainer("testnet");
    const res = await createMarket(
      container,
      req({ deadlineIso: new Date(Date.now() + 200 * 24 * 60 * 60 * 1_000).toISOString() }),
    );
    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.code).toBe(400);
      expect(res.error).toMatch(/180 days/);
    }
  });
});

describe("GET /api/markets/create — the terms the form has to be told", () => {
  it("serves the real bond, treasury and oracle so nothing is hardcoded in the page", async () => {
    realModeWithTreasury();
    vi.stubEnv("CASPER_ORACLE_ACCOUNT", ORACLE);
    const res = await termsGET(new Request("http://localhost/api/markets/create?network=testnet"));
    const json = await res.json();
    expect(json.bondMotes).toBe(creationBondMotes());
    expect(json.walletRequired).toBe(true);
    expect(json.payTo).toBe(TREASURY);
    expect(json.oracle).toBe(ORACLE);
    expect(json.blocker).toBeNull();
  });

  it("reports no oracle rather than offering one the vault would reject", async () => {
    vi.stubEnv("CASPER_CHAIN_MODE", "real");
    vi.stubEnv("CASPER_ORACLE_ACCOUNT", "");
    const res = await termsGET(new Request("http://localhost/api/markets/create?network=testnet"));
    expect((await res.json()).oracle).toBeNull();
  });

  it("a simulated deployment needs no wallet", async () => {
    const res = await termsGET(new Request("http://localhost/api/markets/create?network=testnet"));
    const json = await res.json();
    expect(json.walletRequired).toBe(false);
    expect(json.simulated).toBe(true);
  });
});

/**
 * The loop, closed: the transfer the bond route now builds is the transfer the verifier accepts.
 *
 * The fixture is the RPC's view of exactly that transaction — the visitor as initiator, a native
 * target, the bond amount, the treasury as recipient. If the builder and the verifier ever
 * disagree about any of those four, this fails and the page is back to a permanent 402.
 */
describe("a real bond transfer verifies against the x402 requirement", () => {
  const TX = "dd".repeat(32);
  const requirement: X402PaymentRequirement = {
    amountMotes: creationBondMotes(),
    payTo: TREASURY,
    network: "testnet",
    payer: CREATOR,
    nonce: "bond-nonce",
  };
  const proof: X402PaymentProof = { scheme: "casper-x402", deployHash: TX, nonce: "bond-nonce" };

  function executedTransfer(over: { amount?: string; target?: string; payer?: string } = {}) {
    return {
      jsonrpc: "2.0",
      id: 1,
      result: {
        transaction: {
          Version1: {
            hash: TX,
            payload: {
              initiator_addr: { PublicKey: over.payer ?? CREATOR },
              fields: {
                args: {
                  Named: [
                    ["target", { cl_type: "PublicKey", parsed: over.target ?? TREASURY }],
                    ["amount", { cl_type: "U512", parsed: over.amount ?? creationBondMotes() }],
                  ],
                },
                target: "Native",
                entry_point: "Transfer",
              },
            },
          },
        },
        execution_info: {
          execution_result: { Version2: { error_message: null, transfers: [] } },
        },
      },
    };
  }

  it("accepts the bond transfer", () => {
    expect(verifyTransferResult(executedTransfer(), requirement, proof)).toBe(true);
  });

  it("refuses one paid by somebody else", () => {
    expect(verifyTransferResult(executedTransfer({ payer: `01${"ee".repeat(32)}` }), requirement, proof)).toBe(
      false,
    );
  });

  it("refuses one sent to the wrong account", () => {
    expect(verifyTransferResult(executedTransfer({ target: `01${"ff".repeat(32)}` }), requirement, proof)).toBe(
      false,
    );
  });

  it("refuses one that underpays the bond", () => {
    expect(verifyTransferResult(executedTransfer({ amount: "1" }), requirement, proof)).toBe(false);
  });
});
