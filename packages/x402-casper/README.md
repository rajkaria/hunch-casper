# x402-casper

HTTP-402 micropayments settled by a real Casper transfer. **Payer-bound, single-use,
fails closed, zero runtime dependencies.**

This is the payment rail the [Hunch on Casper](https://casper.playhunch.xyz) agent economy runs
on, extracted so any Casper project can charge for an HTTP endpoint. The package compiles from
the same source the live app serves, so the rail you install is the rail we dogfood.

## Install

```sh
npm i x402-casper
```

## The exchange

1. A client requests a paid resource with no proof.
2. The server answers **402** with a challenge: what to pay, where, and a nonce bound to this
   payer and these parameters.
3. The client sends a native CSPR transfer to `payTo` from the account named in `payer`.
4. The client retries with `X-PAYMENT: base64(json({ scheme, deployHash, nonce }))`.
5. The server reads that transaction from a Casper node and verifies four things at once.

## Server

```ts
import { requirePayment, createSettlementRegistry, encodePaymentResponse } from "x402-casper";

const registry = createSettlementRegistry(); // durable store in production — see SPEC.md

export async function POST(req: Request) {
  const gate = await requirePayment(req, {
    payment,                       // your PaymentPort
    resource: "/api/report",
    quote: { marketId: "report", outcomeKey: "one", amountMotes: "2500000000", payer },
    registry,
  });
  if (!gate.paid) return Response.json(gate.body, { status: gate.status });

  return Response.json(await buildReport(), {
    headers: { "x-payment-response": encodePaymentResponse(gate.proof.deployHash) },
  });
}
```

`requirePayment` returns data, not a `Response`, so it composes with Next route handlers, Express,
Hono, or a bare `fetch` server without any of them becoming a dependency.

## Verifying a payment yourself

The verifier is a pure function over a node-RPC transaction lookup — no network, no key, no
framework. It reads both the Casper 2.0 `info_get_transaction` shape and the legacy
`info_get_deploy` one.

```ts
import { verifyTransferResult } from "x402-casper";

const json = await (await fetch(nodeRpcUrl, { method: "POST", body: rpcBody })).json();
const paid = verifyTransferResult(json, requirement, proof); // boolean, never throws
```

It returns `true` only when **all four** hold:

| Check | Why it matters |
|---|---|
| The transaction executed successfully | A queued or reverted transfer moved nothing |
| Its initiator **is** the requirement's payer | Without this, any hash on chain is a bearer token |
| It moved at least `amountMotes` | — |
| It landed on `payTo` | — |

The second one is the check most implementations miss, and the one that matters most.

## What it does not do

Native CSPR only — so the chainspec's 2.5 CSPR native-transfer minimum is a hard floor on a
single payment. No CEP-18, no escrow, no refunds. It answers one question: did this payer really
pay this much to this account?

## Replay protection

Burn the **settlement id** (the transaction hash), not the nonce. A challenge for a resource is
stable and may be paid many times; each *payment* settles exactly once. `createSettlementRegistry`
is the in-memory reference — correct for one process, **not** for serverless, where N cold
instances each hold their own empty set and the same proof buys N times. Back it with a durable
store there.

## Wire format

[`SPEC.md`](./SPEC.md) describes the challenge, the proof header and the verification rules
precisely enough to reimplement in another language.

## License

MIT
