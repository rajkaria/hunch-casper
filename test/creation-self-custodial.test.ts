/**
 * Self-custodial market creation: `prepare` → (the visitor's wallet signs `create_market`) →
 * `finalize`.
 *
 * This is the path that makes the creation bond genuinely refundable — the visitor is
 * `env().caller()`, so `HunchVault::refund_bond` pays THEM at clean settlement. What is pinned
 * here is not just the happy path but the two properties the money depends on:
 *
 *  1. `prepare` refuses, BEFORE any wallet opens, everything the vault would revert AFTER gas was
 *     spent — the S19 public-creation caps apply to a non-admin caller for the first time.
 *  2. `finalize` cannot be talked into registering a market nobody opened: terms come only from
 *     the ticket `prepare` signed, and nothing is registered until the chain reports a successful
 *     execution.
 *
 * Env is stubbed BEFORE the dynamic imports because `config/network.ts` captures
 * `NEXT_PUBLIC_*_VAULT_V2` at module load.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const CREATOR = `01${"aa".repeat(32)}`;
const ORACLE = `account-hash-${"cc".repeat(32)}`;
const VAULT_V2 = `hash-${"ce".repeat(32)}`;
const SECRET = "test-creation-ticket-secret";

/** ~90 days out — inside the vault's 180-day public-creation horizon. */
const DEADLINE_ISO = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

function specBody(over: Record<string, unknown> = {}) {
  return {
    network: "testnet",
    claim: "Will CSPR cross $0.10 by year end",
    creator: CREATOR,
    oracle: ORACLE,
    source: "coingecko",
    metric: "cspr_usd",
    method: "threshold",
    target: "0.10",
    comparator: "gte",
    deadlineIso: DEADLINE_ISO,
    seedByFleet: false,
    ...over,
  };
}

function post(handler: (req: Request) => Promise<Response>, url: string, body: unknown) {
  return handler(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// Captured once the module graph loads under the stubbed env (see beforeAll).
let preparePOST: (req: Request) => Promise<Response>;
let finalizePOST: (req: Request) => Promise<Response>;
let resetCreatedMarkets: () => void;
let resetActivity: () => void;
let findDefinition: (slug: string) => unknown;

beforeAll(async () => {
  // The vault address must exist before config/network.ts is first imported by this file's
  // module graph — NETWORKS is a const built at load.
  vi.stubEnv("NEXT_PUBLIC_TESTNET_VAULT_V2", VAULT_V2);
  vi.stubEnv("CASPER_BETTOR_KEY", "0".repeat(64));
  vi.stubEnv("BET_TICKET_SECRET", SECRET);
  ({ POST: preparePOST } = await import("@/app/api/markets/create/prepare/route"));
  ({ POST: finalizePOST } = await import("@/app/api/markets/create/finalize/route"));
  ({ __resetCreatedMarkets: resetCreatedMarkets } = await import("@/adapters/mock/market-source"));
  ({ __resetActivity: resetActivity } = await import("@/adapters/mock/activity-log"));
  ({ definitionForSlug: findDefinition } = await import("@/lib/market-create"));
});

afterAll(() => vi.unstubAllEnvs());

beforeEach(() => {
  resetCreatedMarkets();
  resetActivity();
  vi.stubEnv("CASPER_CHAIN_MODE", "real");
  // The hardened composeForCreation accepts only the deployment's approved oracle — a real
  // deployment always has one configured, so these fixtures bind to it.
  vi.stubEnv("CASPER_ORACLE_ACCOUNT", ORACLE);
  vi.unstubAllGlobals();
});

describe("POST /api/markets/create/prepare", () => {
  it("tells a simulated deployment to use the demo handshake (501, not a failure)", async () => {
    vi.stubEnv("CASPER_CHAIN_MODE", "mock");
    const res = await post(preparePOST, "http://localhost/api/markets/create/prepare", specBody());
    expect(res.status).toBe(501);
    expect((await res.json()).error).toMatch(/simulated chain|cannot build/i);
  });

  it("refuses a creator that is not a key anyone can sign with", async () => {
    const res = await post(
      preparePOST,
      "http://localhost/api/markets/create/prepare",
      specBody({ creator: "demo-creator" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/public key/i);
  });

  it("refuses the S19 fee cap breach before the wallet ever opens", async () => {
    const res = await post(
      preparePOST,
      "http://localhost/api/markets/create/prepare",
      specBody({ feeBps: 600 }),
    );
    expect(res.status).toBe(400);
    // The shared composer now rejects the fee before the route's own vault-cap message is built.
    expect((await res.json()).error).toMatch(/caps the fee|between 0 and 500/i);
  });

  it("refuses a deadline beyond the vault's 180-day public horizon", async () => {
    const res = await post(
      preparePOST,
      "http://localhost/api/markets/create/prepare",
      specBody({ deadlineIso: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/180 days/i);
  });

  it("builds the unsigned create_market with the visitor as initiator and mints a ticket", async () => {
    const res = await post(preparePOST, "http://localhost/api/markets/create/prepare", specBody());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.transactionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.bondMotes).toBe("2500000000");
    expect(json.recipeHash).toMatch(/^sha256:/);
    expect(json.slug).toMatch(/^user-will-cspr-cross/);
    expect(typeof json.ticket).toBe("string");
    // The initiator is the CREATOR — the whole point: their signature, their bond, their refund.
    const tx = JSON.parse(json.transactionJson);
    expect(tx.payload.initiator_addr).toEqual({ PublicKey: CREATOR });
    // Nothing was registered — the chain has not executed anything yet.
    expect(findDefinition(json.slug)).toBeUndefined();
  });
});

describe("POST /api/markets/create/finalize", () => {
  /** A prepared creation, ready to "submit". */
  async function prepared() {
    const res = await post(preparePOST, "http://localhost/api/markets/create/prepare", specBody());
    expect(res.status).toBe(200);
    return res.json();
  }

  /** Stub the node RPC with what it says about the ticket's transaction. */
  function stubChain(answer: "pending" | "success" | "failure") {
    const result =
      answer === "pending"
        ? {}
        : {
            execution_info: {
              execution_result: {
                Version2: { error_message: answer === "success" ? null : "User error: 4" },
              },
            },
          };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { transaction: {}, ...result } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  }

  it("rejects a forged ticket with one uniform answer", async () => {
    const res = await post(finalizePOST, "http://localhost/api/markets/create/finalize", {
      ticket: "eyJmYWtlIjp0cnVlfQ.forged",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid or expired/i);
  });

  it("answers pending while the chain has not executed — and registers nothing", async () => {
    const prep = await prepared();
    stubChain("pending");
    const res = await post(finalizePOST, "http://localhost/api/markets/create/finalize", { ticket: prep.ticket });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
    expect(findDefinition(prep.slug)).toBeUndefined();
  });

  it("reports a vault revert honestly — bond returned with the revert, nothing registered", async () => {
    const prep = await prepared();
    stubChain("failure");
    const res = await post(finalizePOST, "http://localhost/api/markets/create/finalize", { ticket: prep.ticket });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("reverted");
    expect(json.error).toMatch(/bond was returned/i);
    expect(findDefinition(prep.slug)).toBeUndefined();
  });

  it("registers the market once the chain confirms, idempotently across polls", async () => {
    const prep = await prepared();
    stubChain("success");
    const res = await post(finalizePOST, "http://localhost/api/markets/create/finalize", { ticket: prep.ticket });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("created");
    expect(json.slug).toBe(prep.slug);
    expect(json.deployHash).toBe(prep.transactionHash);
    expect(findDefinition(prep.slug)).toBeDefined();

    // A second confirmed poll is still "created" — the market IS created; erroring would strand
    // a client that polled twice.
    const again = await post(finalizePOST, "http://localhost/api/markets/create/finalize", { ticket: prep.ticket });
    expect(again.status).toBe(200);
    expect((await again.json()).status).toBe("created");
  });
});

describe("creation ticket", () => {
  it("round-trips claims and refuses tampering and expiry", async () => {
    const { signCreationTicket, verifyCreationTicket, CREATION_TICKET_TTL_MS } = await import(
      "@/lib/creation-ticket"
    );
    const claims = {
      network: "testnet",
      slug: "user-x-0",
      spec: { claim: "x", creator: CREATOR, network: "testnet" as const, seq: 0, deadlineIso: DEADLINE_ISO, source: "coingecko" as const, metric: "m", method: "threshold" as const },
      oracle: ORACLE,
      recipeHash: "sha256:abc",
      bondMotes: "2500000000",
      transactionHash: "ab".repeat(32),
      seedByFleet: true,
      issuedAtMs: Date.now(),
    };
    const ticket = signCreationTicket(claims, SECRET);
    expect(verifyCreationTicket(ticket, SECRET)).toEqual(claims);
    // Tampered payload → MAC dead.
    const [payload, mac] = ticket.split(".");
    const tampered = Buffer.from(payload, "base64url").toString("utf8").replace('"user-x-0"', '"user-y-0"');
    expect(
      verifyCreationTicket(`${Buffer.from(tampered).toString("base64url")}.${mac}`, SECRET),
    ).toBeNull();
    // Wrong secret → dead. Expired → dead.
    expect(verifyCreationTicket(ticket, "other-secret")).toBeNull();
    expect(verifyCreationTicket(ticket, SECRET, Date.now() + CREATION_TICKET_TTL_MS + 1)).toBeNull();
  });
});
