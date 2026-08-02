/**
 * S32/W4 — the `x402-casper` package surface.
 *
 * The rail was the most reusable thing in this repository and the least reachable: a Casper
 * project wanting payer-bound HTTP micropayments had to reimplement it from our adapter source.
 * These tests pin the extracted surface — the wire format, the replay rule, and the gate — as a
 * contract other implementations can be checked against, and pin that the app's own 402 route
 * still speaks exactly what `SPEC.md` documents.
 */
import { describe, it, expect } from "vitest";
import {
  X402_SCHEME,
  X402_VERSION,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  encodeChallenge,
  encodeProofHeader,
  decodeProofHeader,
  readProof,
  encodePaymentResponse,
  createSettlementRegistry,
  requirePayment,
  payAndRetry,
  verifyTransferResult,
} from "@/x402";
import type { X402PaymentRequirement, PaymentPort } from "@/ports/payment";

const REQUIREMENT: X402PaymentRequirement = {
  amountMotes: "2500000000",
  payTo: "01aa" + "b".repeat(62),
  network: "testnet",
  payer: "01cc" + "d".repeat(62),
  nonce: "nonce-1",
};

describe("the challenge is the shape SPEC.md documents", () => {
  it("encodes an accepts[] entry a generic x402 client can read", () => {
    const body = encodeChallenge(REQUIREMENT, "/api/report#one");
    expect(body.x402Version).toBe(X402_VERSION);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0]).toEqual({
      scheme: X402_SCHEME,
      network: "testnet",
      asset: "CSPR",
      maxAmountRequired: "2500000000",
      payTo: REQUIREMENT.payTo,
      nonce: "nonce-1",
      resource: "/api/report#one",
    });
  });

  it("carries a caller-supplied error so a rejected proof is distinguishable from a first ask", () => {
    expect(encodeChallenge(REQUIREMENT, "/r", "x402 payment already spent").error).toBe(
      "x402 payment already spent",
    );
  });
});

describe("the proof header round-trips", () => {
  it("encodes and decodes a proof", () => {
    const header = encodeProofHeader({ scheme: X402_SCHEME, deployHash: "ab".repeat(32), nonce: "n" });
    expect(decodeProofHeader(header)).toEqual({
      scheme: X402_SCHEME,
      deployHash: "ab".repeat(32),
      nonce: "n",
    });
  });

  it("reads a proof straight off a Request", () => {
    const header = encodeProofHeader({ scheme: X402_SCHEME, deployHash: "cd".repeat(32), nonce: "n" });
    const req = new Request("http://x", { headers: { [PAYMENT_HEADER]: header } });
    expect(readProof(req)?.deployHash).toBe("cd".repeat(32));
  });

  it.each([
    ["absent", null],
    ["not base64", "!!!!"],
    ["not json", Buffer.from("hello").toString("base64")],
    ["wrong scheme", Buffer.from(JSON.stringify({ scheme: "evm", deployHash: "a", nonce: "n" })).toString("base64")],
    ["no settlement id", Buffer.from(JSON.stringify({ scheme: X402_SCHEME, nonce: "n" })).toString("base64")],
  ])("treats a %s header as NO payment rather than an invalid one", (_label, header) => {
    // The distinction matters: "no payment" routes the caller back to a fresh 402 instead of into
    // verification with a half-formed proof.
    expect(decodeProofHeader(header as string | null)).toBeUndefined();
  });

  it("acknowledges a settled payment", () => {
    const decoded = JSON.parse(Buffer.from(encodePaymentResponse("ef".repeat(32)), "base64").toString());
    expect(decoded).toEqual({ success: true, deployHash: "ef".repeat(32) });
    expect(PAYMENT_RESPONSE_HEADER).toBe("x-payment-response");
  });
});

describe("the settlement registry burns hashes, not nonces", () => {
  it("lets a settlement through exactly once", () => {
    const registry = createSettlementRegistry();
    expect(registry.consume("AB".repeat(32))).toBe(true);
    expect(registry.consume("ab".repeat(32))).toBe(false); // case must not mint a second spend
    expect(registry.has("ab".repeat(32))).toBe(true);
  });

  it("accepts a second, different payment for the same resource", () => {
    // A challenge is stable and may be paid many times; each PAYMENT settles once.
    const registry = createSettlementRegistry();
    expect(registry.consume("11".repeat(32))).toBe(true);
    expect(registry.consume("22".repeat(32))).toBe(true);
  });
});

describe("requirePayment gate", () => {
  const payment = (verify: boolean): PaymentPort => ({
    quote: async () => REQUIREMENT,
    settle: async () => ({ scheme: X402_SCHEME, deployHash: "ab".repeat(32), nonce: "nonce-1" }),
    verify: async () => verify,
  });
  const quote = { marketId: "m", outcomeKey: "yes", amountMotes: "2500000000", payer: REQUIREMENT.payer };
  const withProof = (hash: string) =>
    new Request("http://x", {
      headers: { [PAYMENT_HEADER]: encodeProofHeader({ scheme: X402_SCHEME, deployHash: hash, nonce: "nonce-1" }) },
    });

  it("challenges an unpaid request", async () => {
    const gate = await requirePayment(new Request("http://x"), {
      payment: payment(true),
      resource: "/r",
      quote,
    });
    expect(gate.paid).toBe(false);
    if (!gate.paid) expect(gate.status).toBe(402);
  });

  it("lets a verified proof through", async () => {
    const gate = await requirePayment(withProof("ab".repeat(32)), {
      payment: payment(true),
      resource: "/r",
      quote,
    });
    expect(gate.paid).toBe(true);
  });

  it("rejects a proof the port cannot verify", async () => {
    const gate = await requirePayment(withProof("ab".repeat(32)), {
      payment: payment(false),
      resource: "/r",
      quote,
    });
    expect(gate.paid).toBe(false);
    if (!gate.paid) expect(gate.body.error).toMatch(/unverifiable/);
  });

  it("rejects a replayed settlement", async () => {
    const registry = createSettlementRegistry();
    const opts = { payment: payment(true), resource: "/r", quote, registry };
    expect((await requirePayment(withProof("ab".repeat(32)), opts)).paid).toBe(true);
    const second = await requirePayment(withProof("ab".repeat(32)), opts);
    expect(second.paid).toBe(false);
    if (!second.paid) expect(second.body.error).toMatch(/already spent/);
  });
});

describe("payAndRetry", () => {
  it("passes a non-402 response straight through without settling", async () => {
    let settled = 0;
    const res = await payAndRetry(
      async () => new Response("ok", { status: 200 }),
      async () => {
        settled++;
        return "ab".repeat(32);
      },
      async () => new Response("retried", { status: 200 }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(settled).toBe(0);
  });

  it("settles a 402 and retries exactly once with the proof header", async () => {
    let header = "";
    const res = await payAndRetry(
      async () => new Response(JSON.stringify(encodeChallenge(REQUIREMENT, "/r")), { status: 402 }),
      async (challenge) => {
        expect(challenge.maxAmountRequired).toBe("2500000000");
        return "ab".repeat(32);
      },
      async (h) => {
        header = h;
        return new Response("paid", { status: 200 });
      },
    );
    expect(res.status).toBe(200);
    expect(decodeProofHeader(header)).toEqual({
      scheme: X402_SCHEME,
      deployHash: "ab".repeat(32),
      nonce: "nonce-1",
    });
  });

  it("does not settle a 402 whose scheme is some other chain's", async () => {
    let settled = 0;
    const foreign = { x402Version: 1, error: "payment required", accepts: [{ scheme: "evm-x402" }] };
    const res = await payAndRetry(
      async () => new Response(JSON.stringify(foreign), { status: 402 }),
      async () => {
        settled++;
        return "ab".repeat(32);
      },
      async () => new Response("retried", { status: 200 }),
    );
    expect(settled).toBe(0);
    expect(res.status).toBe(402);
  });
});

describe("the verifier is still the one the app runs on", () => {
  it("re-exports the same pure function the real PaymentPort uses", async () => {
    const adapter = await import("@/adapters/casper/real-payment");
    expect(adapter.verifyTransferResult).toBe(verifyTransferResult);
  });

  it("fails closed on a payload it cannot read", () => {
    const proof = { scheme: "casper-x402" as const, deployHash: "ab".repeat(32), nonce: "nonce-1" };
    expect(verifyTransferResult(null, REQUIREMENT, proof)).toBe(false);
    expect(verifyTransferResult({ error: "boom" }, REQUIREMENT, proof)).toBe(false);
    expect(verifyTransferResult({ result: {} }, REQUIREMENT, proof)).toBe(false);
  });
});
