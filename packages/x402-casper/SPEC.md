# x402-casper wire format

Version `1`. Everything here is implementation-independent: a server and a client that follow this
document interoperate regardless of language.

## 1. Challenge (HTTP 402 response body)

```jsonc
{
  "x402Version": 1,
  "error": "payment required",
  "accepts": [
    {
      "scheme": "casper-x402",
      "network": "testnet",              // or "mainnet"
      "asset": "CSPR",                   // native token only
      "maxAmountRequired": "2500000000", // motes; 1 CSPR = 1e9 motes
      "payTo": "01ab…",                  // public key hex OR account-hash-…
      "nonce": "…",                      // bound to payer + request parameters
      "resource": "/api/report#id"       // opaque identifier for what is being bought
    }
  ]
}
```

A server MAY add sibling fields (Hunch adds `previewPayoutMotes`). A client MUST ignore
fields it does not recognise, and MUST NOT treat an `accepts[]` entry whose `scheme` is not
`casper-x402` as payable by this rail.

`nonce` is opaque to the client: it is echoed back verbatim in the proof. Its binding to the payer
is a server-side property, and a server MUST bind it — otherwise a challenge issued to one payer
can be satisfied by another's transfer.

## 2. Payment

A native CSPR transfer, submitted by the payer's own key:

- **initiator** = the account the challenge was issued to;
- **target** = `payTo`;
- **amount** ≥ `maxAmountRequired`.

The Casper chainspec sets `core.native_transfer_minimum_motes` = 2 500 000 000 (2.5 CSPR). A
challenge below that floor is unpayable in a single native transfer, and a server SHOULD NOT
issue one.

## 3. Proof (request header)

```
X-PAYMENT: base64(json({ "scheme": "casper-x402", "deployHash": "<64 hex>", "nonce": "<echoed>" }))
```

`deployHash` is the transaction hash of the transfer. A header that does not decode to an object
carrying this scheme, a non-empty `deployHash` and a string `nonce` MUST be treated as **no
payment**, not as an invalid one — the caller gets a fresh 402 rather than a verification error.

## 4. Acknowledgement (response header)

```
X-PAYMENT-RESPONSE: base64(json({ "success": true, "deployHash": "<64 hex>" }))
```

## 5. Verification rules

Given the challenge, the proof, and a node-RPC lookup of `deployHash`, a payment is settled if
and only if **all** of the following hold. Any payload that cannot be fully evaluated — malformed,
pending, partial, unreadable, unknown shape — MUST verify as **not settled**. Fail closed.

1. The RPC returned a transaction body, in either the 2.0 shape (`result.transaction.Version1`
   with `result.execution_info.execution_result`) or the legacy one (`result.transaction.Deploy` /
   `result.deploy` with `result.execution_results[0].result`).
2. If the response echoes a transaction hash, it equals `deployHash` (case-insensitive).
3. The execution **succeeded** — a `Version2` result with no `error_message`, or a legacy
   `Success` wrapper. A pending or unexecuted transaction is not settled.
4. The **initiator is the payer**: `payload.initiator_addr.PublicKey`,
   `payload.initiator_addr.AccountHash`, or the legacy `deploy.header.account`, compared to the
   challenge's payer.
5. Money moved: at least `maxAmountRequired` motes reached `payTo`, taken from either the native
   transfer args (only when the transaction is marked as a native transfer — a contract call
   carrying `target`/`amount` args MUST NOT qualify) or the executed transfer records.

### Account comparison

Identifiers are compared case-insensitively after stripping a leading `account-hash-`, `hash-`, or
`0x`. A public key and its account hash remain **different values** — deriving one from the other
requires blake2b — which is why `payTo` is compared against both the session-arg target (public
key form) and the executed transfer records' `to` (account-hash form).

## 6. Replay

A server MUST burn the **settlement id** (`deployHash`), not the nonce, and MUST reject a proof
whose settlement id has already been spent. The store MUST be durable across instances wherever
the server can run as more than one process.
