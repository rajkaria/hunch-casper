/**
 * Real x402 PaymentPort — on-chain CSPR-transfer verification. The pure `verifyTransferResult`
 * is exercised against both node-RPC response shapes (Casper 2.0 `info_get_transaction`
 * TransactionV1 + legacy `info_get_deploy` Deploy), `verify()` end-to-end with an injected
 * fetch, and the real-mode agent-rail gate: setting `CASPER_X402_PAYTO` (trustless transfer
 * verification) must open the rail just like the legacy `CASPER_REAL_AGENT_X402=true` opt-in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRealPayment, verifyTransferResult } from "@/adapters/casper/real-payment";
import type { X402PaymentProof, X402PaymentRequirement } from "@/ports/payment";
import { agentBet, __resetConsumedNonces } from "@/lib/agent-bet";
import { createContainer } from "@/lib/container";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";

const PAYER = `01${"aa".repeat(32)}`; // agent's public key (hex)
const OTHER_PAYER = `01${"ee".repeat(32)}`;
const PAY_TO = `01${"bb".repeat(32)}`; // operator treasury public key (CASPER_X402_PAYTO)
const PAY_TO_ACCOUNT_HASH = `account-hash-${"cc".repeat(32)}`;
const TX_HASH = "dd".repeat(32);

const REQ: X402PaymentRequirement = {
  amountMotes: "1000000000",
  payTo: PAY_TO,
  network: "testnet",
  payer: PAYER,
  nonce: "nonce-1",
};

const PROOF: X402PaymentProof = { scheme: "casper-x402", deployHash: TX_HASH, nonce: "nonce-1" };

/** Casper 2.0 `info_get_transaction` response — TransactionV1 + Version2 execution result. */
function txV1Fixture(over: { payer?: string; target?: string; amount?: string; error?: string | null } = {}) {
  const payer = over.payer ?? PAYER;
  const target = over.target ?? PAY_TO;
  const amount = over.amount ?? REQ.amountMotes;
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      api_version: "2.0.0",
      transaction: {
        Version1: {
          hash: TX_HASH,
          payload: {
            initiator_addr: { PublicKey: payer },
            chain_name: "casper-test",
            fields: {
              args: {
                Named: [
                  ["target", { cl_type: "PublicKey", parsed: target }],
                  ["amount", { cl_type: "U512", parsed: amount }],
                  ["id", { cl_type: { Option: "U64" }, parsed: null }],
                ],
              },
              target: "Native",
              entry_point: "Transfer",
              scheduling: "Standard",
            },
          },
        },
      },
      execution_info: {
        block_hash: "00".repeat(32),
        block_height: 3_400_001,
        execution_result: {
          Version2: {
            initiator: { PublicKey: payer },
            error_message: over.error ?? null,
            cost: "100000000",
            transfers: [
              {
                transaction_hash: { Version1: TX_HASH },
                from: { AccountHash: `account-hash-${"11".repeat(32)}` },
                to: PAY_TO_ACCOUNT_HASH,
                source: `uref-${"12".repeat(32)}-007`,
                target: `uref-${"13".repeat(32)}-007`,
                amount,
                gas: "0",
                id: null,
              },
            ],
          },
        },
      },
    },
  };
}

/** Legacy `info_get_deploy` response — Deploy session Transfer + execution_results[]. */
function deployFixture(over: { payer?: string; target?: string; amount?: string; failed?: boolean } = {}) {
  const payer = over.payer ?? PAYER;
  const target = over.target ?? PAY_TO;
  const amount = over.amount ?? REQ.amountMotes;
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      api_version: "1.5.6",
      deploy: {
        hash: TX_HASH,
        header: { account: payer, chain_name: "casper-test", timestamp: "2026-07-01T00:00:00Z" },
        session: {
          Transfer: {
            args: [
              ["amount", { cl_type: "U512", parsed: amount }],
              ["target", { cl_type: "PublicKey", parsed: target }],
              ["id", { cl_type: { Option: "U64" }, parsed: null }],
            ],
          },
        },
      },
      execution_results: [
        {
          block_hash: "00".repeat(32),
          result: over.failed
            ? { Failure: { error_message: "User error: 65533", cost: "100000000" } }
            : { Success: { cost: "100000000", transfers: [`transfer-${"14".repeat(32)}`] } },
        },
      ],
    },
  };
}

describe("verifyTransferResult (pure, both RPC shapes)", () => {
  it("accepts a successful TransactionV1 native transfer from the payer to payTo", () => {
    expect(verifyTransferResult(txV1Fixture(), REQ, PROOF)).toBe(true);
  });

  it("accepts an over-payment (amount above the requirement)", () => {
    expect(verifyTransferResult(txV1Fixture({ amount: "2000000000" }), REQ, PROOF)).toBe(true);
  });

  it("rejects an amount below the requirement", () => {
    expect(verifyTransferResult(txV1Fixture({ amount: "999999999" }), REQ, PROOF)).toBe(false);
  });

  it("rejects a transfer initiated by someone other than the bound payer", () => {
    expect(verifyTransferResult(txV1Fixture({ payer: OTHER_PAYER }), REQ, PROOF)).toBe(false);
  });

  it("rejects a transfer to the wrong target", () => {
    const json = txV1Fixture({ target: `01${"99".repeat(32)}` });
    // Also break the transfers[] record so neither location matches payTo.
    const v2 = json.result.execution_info.execution_result.Version2;
    v2.transfers[0].to = `account-hash-${"98".repeat(32)}`;
    expect(verifyTransferResult(json, REQ, PROOF)).toBe(false);
  });

  it("rejects a failed execution (error_message set)", () => {
    expect(verifyTransferResult(txV1Fixture({ error: "User error: 65533" }), REQ, PROOF)).toBe(false);
  });

  it("matches payTo in account-hash form against the transfers[] record", () => {
    // Treasury configured as an account-hash: the session arg target (a public key) can't match,
    // but the executed transfer record's `to` does.
    const req = { ...REQ, payTo: PAY_TO_ACCOUNT_HASH };
    expect(verifyTransferResult(txV1Fixture({ target: `01${"99".repeat(32)}` }), req, PROOF)).toBe(true);
  });

  it("accepts a successful legacy Deploy transfer (info_get_deploy shape)", () => {
    expect(verifyTransferResult(deployFixture(), REQ, PROOF)).toBe(true);
  });

  it("rejects a failed legacy Deploy execution", () => {
    expect(verifyTransferResult(deployFixture({ failed: true }), REQ, PROOF)).toBe(false);
  });

  it("rejects a legacy Deploy from the wrong account", () => {
    expect(verifyTransferResult(deployFixture({ payer: OTHER_PAYER }), REQ, PROOF)).toBe(false);
  });

  it("rejects malformed payloads without throwing", () => {
    for (const bad of [null, undefined, 42, "nope", {}, { result: {} }, { error: { code: -32602 } }, { result: { transaction: {} } }, [1, 2]]) {
      expect(verifyTransferResult(bad, REQ, PROOF)).toBe(false);
    }
  });

  it("rejects a pending transaction (no execution info yet)", () => {
    const json = txV1Fixture() as unknown as { result: Record<string, unknown> };
    delete json.result.execution_info;
    expect(verifyTransferResult(json, REQ, PROOF)).toBe(false);
  });
});

/** JSON-RPC fetch stub — routes by method, records calls. */
function rpcFetch(responder: (method: string) => unknown) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const method = (JSON.parse(String(init?.body)) as { method: string }).method;
    calls.push(method);
    return new Response(JSON.stringify(responder(method)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const RPC_NOT_FOUND = { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "no such transaction" } };

describe("createRealPayment", () => {
  it("quote() binds the nonce to the payer and pays to the configured treasury", async () => {
    const payment = createRealPayment("testnet", PAY_TO);
    const a = await payment.quote({ marketId: "m", outcomeKey: "yes", amountMotes: "5", payer: PAYER });
    const b = await payment.quote({ marketId: "m", outcomeKey: "yes", amountMotes: "5", payer: OTHER_PAYER });
    expect(a.payTo).toBe(PAY_TO);
    expect(a.payer).toBe(PAYER);
    expect(a.network).toBe("testnet");
    expect(a.amountMotes).toBe("5");
    expect(a.nonce).not.toBe(b.nonce); // payer-bound
  });

  it("settle() refuses — a real agent pays from its own wallet", async () => {
    const payment = createRealPayment("testnet", PAY_TO);
    await expect(payment.settle(REQ, PAYER)).rejects.toThrow(/own wallet/i);
  });

  it("verify() accepts a proof whose on-chain transfer checks out (info_get_transaction)", async () => {
    const { fetchImpl, calls } = rpcFetch(() => txV1Fixture());
    const payment = createRealPayment("testnet", PAY_TO, { fetchImpl });
    expect(await payment.verify(REQ, PROOF)).toBe(true);
    expect(calls).toEqual(["info_get_transaction"]);
  });

  it("verify() falls back to info_get_deploy for a legacy Deploy hash", async () => {
    const { fetchImpl, calls } = rpcFetch((method) =>
      method === "info_get_transaction" ? RPC_NOT_FOUND : deployFixture(),
    );
    const payment = createRealPayment("testnet", PAY_TO, { fetchImpl });
    expect(await payment.verify(REQ, PROOF)).toBe(true);
    expect(calls).toEqual(["info_get_transaction", "info_get_deploy"]);
  });

  it("verify() rejects when both RPC lookups error", async () => {
    const { fetchImpl } = rpcFetch(() => RPC_NOT_FOUND);
    const payment = createRealPayment("testnet", PAY_TO, { fetchImpl });
    expect(await payment.verify(REQ, PROOF)).toBe(false);
  });

  it("verify() rejects when the node is unreachable (fetch throws)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const payment = createRealPayment("testnet", PAY_TO, { fetchImpl });
    expect(await payment.verify(REQ, PROOF)).toBe(false);
  });

  it("verify() rejects a nonce/scheme mismatch without touching the network", async () => {
    const { fetchImpl, calls } = rpcFetch(() => txV1Fixture());
    const payment = createRealPayment("testnet", PAY_TO, { fetchImpl });
    expect(await payment.verify(REQ, { ...PROOF, nonce: "tampered" })).toBe(false);
    expect(await payment.verify(REQ, { ...PROOF, scheme: "nope" as "casper-x402" })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("verify() rejects a fabricated (non-hash) settlement id without touching the network", async () => {
    // Exactly what the internal Prophet fleet's mock settle() produces — in real+real-payment
    // mode those proofs must fail closed rather than hit the RPC.
    const { fetchImpl, calls } = rpcFetch(() => txV1Fixture());
    const payment = createRealPayment("testnet", PAY_TO, { fetchImpl });
    expect(await payment.verify(REQ, { ...PROOF, deployHash: `x402-settled-${REQ.nonce}-1` })).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("real-mode agent rail gating (container + agent-bet)", () => {
  const BET = {
    marketId: "testnet:btc-150k-aug",
    outcomeKey: "yes",
    amountMotes: "1000000000",
    bettor: PAYER,
  };

  beforeEach(() => {
    __resetLedger();
    __resetConsumedNonces();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stays fail-closed in real mode with neither opt-in configured", async () => {
    vi.stubEnv("CASPER_CHAIN_MODE", "real");
    const res = await agentBet(createContainer("testnet"), BET);
    expect(res).toMatchObject({ status: "error", code: 503 });
  });

  it("opens the rail in real mode when CASPER_X402_PAYTO is set (trustless verification)", async () => {
    vi.stubEnv("CASPER_CHAIN_MODE", "real");
    vi.stubEnv("CASPER_X402_PAYTO", PAY_TO);
    // No proof yet → quote step only; no chain access happens before a proof is presented.
    const res = await agentBet(createContainer("testnet"), BET);
    expect(res.status).toBe("payment_required");
    if (res.status === "payment_required") {
      expect(res.requirement.payTo).toBe(PAY_TO); // the REAL adapter produced the challenge
      expect(res.requirement.payer).toBe(PAYER);
    }
  });

  it("still honors the legacy CASPER_REAL_AGENT_X402=true opt-in (mock verification)", async () => {
    vi.stubEnv("CASPER_CHAIN_MODE", "real");
    vi.stubEnv("CASPER_REAL_AGENT_X402", "true");
    const res = await agentBet(createContainer("testnet"), BET);
    expect(res.status).toBe("payment_required");
  });

  it("keeps mock mode exactly as before (no env, rail open, mock payTo)", async () => {
    const res = await agentBet(createContainer("testnet"), BET);
    expect(res.status).toBe("payment_required");
  });
});
