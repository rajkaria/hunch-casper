/**
 * x402-casper — HTTP-402 micropayments settled by a real Casper transfer.
 *
 * This is the public, reusable surface of the rail the Hunch agent economy runs on, extracted so
 * any Casper project can charge for an HTTP endpoint without reimplementing it from our source.
 * It is deliberately tiny and has **zero runtime dependencies**: no `casper-js-sdk`, no framework,
 * nothing but `fetch` and JSON. A verifier is a pure function over a node-RPC payload, so it can
 * run anywhere — an edge function, a keeper, another language's test vectors.
 *
 * ## The exchange
 *
 * 1. A client requests a paid resource with no proof.
 * 2. The server answers **402** with a {@link X402Challenge}: what to pay, where, and a nonce
 *    bound to this payer and these parameters.
 * 3. The client sends a native CSPR transfer to `payTo` from the account named in `payer`.
 * 4. The client retries with `X-PAYMENT: base64(json({ scheme, deployHash, nonce }))`.
 * 5. The server reads that transaction from a Casper node and verifies four things at once:
 *    it executed successfully, its initiator IS the payer, it moved at least `amountMotes`, and
 *    it landed on `payTo`.
 *
 * ## What makes it safe
 *
 * **Payer-bound.** A challenge names the account that must pay. A proof for one payer cannot
 * settle another's request, so an observed transfer hash is not a bearer token.
 *
 * **Single-use.** The settlement id — the transaction hash, not the nonce — is what a server
 * burns. A challenge for a resource is stable and may be paid many times; each *payment* settles
 * exactly once. Replay protection therefore has to key on the hash, and {@link createSettlementRegistry}
 * is the reference in-memory implementation of that rule (production wants a durable set).
 *
 * **Fails closed.** Every malformed, pending, partial or unreadable payload verifies to `false`.
 * There is no path where "I could not tell" means "paid".
 *
 * ## Non-goals
 *
 * No token support (native CSPR only, so the chainspec's 2.5 CSPR native-transfer minimum is a
 * hard floor on a single payment), no escrow, no refunds. It answers exactly one question: did
 * this payer really pay this much to this account?
 */

// Relative imports throughout, and no `@/` alias: the emitted `.d.ts` must resolve for an npm
// consumer who has never heard of this repo's tsconfig paths.
import type {
  PaymentPort,
  QuoteInput,
  X402PaymentProof,
  X402PaymentRequirement,
} from "../ports/payment";
import { verifyTransferResult } from "./verify";
import type { CasperNetwork } from "../config/network";

export type { PaymentPort, QuoteInput, X402PaymentProof, X402PaymentRequirement, CasperNetwork };
export { verifyTransferResult };

/** The scheme identifier carried by every challenge and proof on this rail. */
export const X402_SCHEME = "casper-x402";

/** The `x402Version` this implementation speaks. */
export const X402_VERSION = 1;

/** The header a client presents its proof in. */
export const PAYMENT_HEADER = "x-payment";

/** The header a server acknowledges a settled payment in. */
export const PAYMENT_RESPONSE_HEADER = "x-payment-response";

/**
 * One payment option in a 402 body. Mirrors the x402 `accepts[]` shape so a generic client can
 * read it, with `nonce` carrying the payer binding.
 */
export interface X402Challenge {
  scheme: typeof X402_SCHEME;
  network: CasperNetwork;
  /** Always `"CSPR"` — this rail settles in the native token only. */
  asset: "CSPR";
  /** The most the resource will charge, in motes (1 CSPR = 1e9 motes). */
  maxAmountRequired: string;
  /** The account the transfer must land on. */
  payTo: string;
  /** Replay/binding nonce, bound to the payer and the request parameters. */
  nonce: string;
  /** An opaque identifier for what is being bought. */
  resource: string;
}

/** The complete body a server returns with HTTP 402. */
export interface X402ChallengeBody {
  x402Version: typeof X402_VERSION;
  error: string;
  accepts: X402Challenge[];
}

/** Turn a requirement into the 402 body a client can act on without prior knowledge. */
export function encodeChallenge(
  requirement: X402PaymentRequirement,
  resource: string,
  error = "payment required",
): X402ChallengeBody {
  return {
    x402Version: X402_VERSION,
    error,
    accepts: [
      {
        scheme: X402_SCHEME,
        network: requirement.network,
        asset: "CSPR",
        maxAmountRequired: requirement.amountMotes,
        payTo: requirement.payTo,
        nonce: requirement.nonce,
        resource,
      },
    ],
  };
}

/** Base64 for a proof header, in whichever runtime this is loaded in (Node or the browser). */
function toBase64(json: string): string {
  if (typeof btoa === "function") return btoa(json);
  return Buffer.from(json, "utf8").toString("base64");
}

function fromBase64(b64: string): string {
  if (typeof atob === "function") return atob(b64);
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Encode a proof for the `X-PAYMENT` request header. */
export function encodeProofHeader(proof: X402PaymentProof): string {
  return toBase64(JSON.stringify(proof));
}

/**
 * Decode an `X-PAYMENT` header into a proof, or `undefined` if it is absent or unreadable.
 *
 * Never throws and never partially trusts: a header that does not decode to an object carrying
 * this scheme and a settlement hash is treated as no payment at all, which routes the caller
 * back to a 402 rather than into verification with a half-formed proof.
 */
export function decodeProofHeader(header: string | null | undefined): X402PaymentProof | undefined {
  if (!header) return undefined;
  try {
    const parsed = JSON.parse(fromBase64(header)) as Partial<X402PaymentProof>;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (parsed.scheme !== X402_SCHEME) return undefined;
    if (typeof parsed.deployHash !== "string" || parsed.deployHash.length === 0) return undefined;
    if (typeof parsed.nonce !== "string") return undefined;
    return { scheme: X402_SCHEME, deployHash: parsed.deployHash, nonce: parsed.nonce };
  } catch {
    return undefined;
  }
}

/** Read a proof straight off a `Request` (or anything with `headers.get`). */
export function readProof(req: { headers: { get(name: string): string | null } }): X402PaymentProof | undefined {
  return decodeProofHeader(req.headers.get(PAYMENT_HEADER));
}

/** Encode the `X-PAYMENT-RESPONSE` acknowledgement a server returns once a payment settles. */
export function encodePaymentResponse(deployHash: string): string {
  return toBase64(JSON.stringify({ success: true, deployHash }));
}

/**
 * A settlement registry: one payment, one resource.
 *
 * Keyed on the transaction hash rather than the nonce, for the reason in the module docs. This
 * in-memory implementation is correct for a single process and **not** sufficient for a
 * serverless deployment, where N cold instances each hold their own empty Set — back it with a
 * durable store there, or the same proof buys N times.
 */
export function createSettlementRegistry(): {
  consume(deployHash: string): boolean;
  has(deployHash: string): boolean;
  clear(): void;
} {
  const spent = new Set<string>();
  return {
    /** Burn a settlement. Returns false if it was already spent — reject the request then. */
    consume(deployHash: string): boolean {
      const key = deployHash.toLowerCase();
      if (spent.has(key)) return false;
      spent.add(key);
      return true;
    },
    has: (deployHash: string) => spent.has(deployHash.toLowerCase()),
    clear: () => spent.clear(),
  };
}

/** What {@link requirePayment} decided about a request. */
export type PaymentGate =
  | { paid: true; proof: X402PaymentProof }
  | { paid: false; status: 402; body: X402ChallengeBody }
  | { paid: false; status: 402; body: { x402Version: number; error: string; accepts: [] } };

/**
 * The server-side gate, framework-free: given a request and a way to quote it, either let it
 * through with a verified proof or hand back the 402 body to return.
 *
 * Deliberately returns data rather than a `Response`, so it composes with Next route handlers,
 * Express, Hono, or a bare `fetch` server without any of them being a dependency.
 *
 * ```ts
 * const gate = await requirePayment(req, {
 *   payment,                                   // your PaymentPort
 *   resource: "/api/report",
 *   quote: { marketId: "report", outcomeKey: "one", amountMotes: "2500000000", payer },
 * });
 * if (!gate.paid) return Response.json(gate.body, { status: gate.status });
 * ```
 */
export async function requirePayment(
  req: { headers: { get(name: string): string | null } },
  opts: {
    payment: PaymentPort;
    resource: string;
    quote: QuoteInput;
    /** Optional replay registry. Omit to skip the single-use check (not recommended). */
    registry?: ReturnType<typeof createSettlementRegistry>;
  },
): Promise<PaymentGate> {
  const requirement = await opts.payment.quote(opts.quote);
  const proof = readProof(req);
  if (!proof) {
    return { paid: false, status: 402, body: encodeChallenge(requirement, opts.resource) };
  }
  const ok = await opts.payment.verify(requirement, proof);
  if (!ok) {
    return {
      paid: false,
      status: 402,
      body: encodeChallenge(requirement, opts.resource, "invalid or unverifiable x402 payment proof"),
    };
  }
  if (opts.registry && !opts.registry.consume(proof.deployHash)) {
    return {
      paid: false,
      status: 402,
      body: encodeChallenge(requirement, opts.resource, "x402 payment already spent"),
    };
  }
  return { paid: true, proof };
}

/**
 * The client side: call a paid endpoint, settle a 402 if one comes back, and retry once.
 *
 * `settle` is yours to implement — it is the only step that needs a key, and this package
 * deliberately never touches one. It receives the challenge and returns the hash of the transfer
 * it made. Exactly one retry: a second 402 after a paid settlement is a real failure (wrong
 * amount, wrong target, unconfirmed transfer) and looping on it would spend again.
 */
export async function payAndRetry(
  request: () => Promise<Response>,
  settle: (challenge: X402Challenge) => Promise<string>,
  retryWithProof: (header: string) => Promise<Response>,
): Promise<Response> {
  const first = await request();
  if (first.status !== 402) return first;

  const body = (await first.json()) as X402ChallengeBody;
  const challenge = body?.accepts?.[0];
  if (!challenge || challenge.scheme !== X402_SCHEME) return first;

  const deployHash = await settle(challenge);
  return retryWithProof(encodeProofHeader({ scheme: X402_SCHEME, deployHash, nonce: challenge.nonce }));
}
