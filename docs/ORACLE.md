# Oracle as a service (S26)

Hunch's resolution capability is a product other Casper protocols can buy and bind to. Two
surfaces: a **query API** ("is this claim true?", priced per query) and **settlement hooks** (a
contract binds to a Hunch resolution and acts on the outcome). Both are built on the verifiable
resolution from S24 — every answer carries the evidence-bundle hash, so a consumer trusts the math,
not our word.

## 1. Query API — buy an answer

`POST /api/oracle/query`

```jsonc
// request
{ "network": "testnet", "slug": "cspr-price-05-aug", "caller": "your-protocol" }
```

```jsonc
// 200 response
{
  "market": { "slug": "cspr-price-05-aug", "question": "CSPR above $0.05 by Aug 1?", "status": "resolved" },
  "answer": { "resolved": true, "winningOutcomeKey": "yes", "claimResolvedTrue": true },
  "evidence": { "recipeHash": "sha256:…", "bundleHash": "sha256:…", "uri": "cas:sha256:…" },
  "oracle":   { "id": "arbiter", "accuracyBps": 9500, "resolvedCount": 42 },
  "meter":    { "tier": "free", "remainingFree": 19 }
}
```

The answer carries:
- **the decided outcome** (`winningOutcomeKey`) and, for yes/no-style markets, `claimResolvedTrue`;
- **the evidence-bundle hash** — fetch it, recompute the hash, and replay the recipe (S24) to
  confirm the winner before you act;
- **the answering oracle's on-chain reputation**, so you can weigh the answer by its track record.

### Pricing & metering (`src/core/query-pricing.ts`)

- **Free ecosystem tier:** N queries per caller per hour (`ORACLE_FREE_QUERIES_PER_HOUR`, default
  20). Meant for integration, dashboards, and light use.
- **Paid tier:** past the free quota the endpoint returns **HTTP 402** with an x402 requirement.
  Pay the CSPR (`ORACLE_PAID_QUERY_MOTES`, default 0.1 CSPR) and retry with the transfer's deploy
  hash as the proof. Payments are replay-protected (one settlement, one query).

The S19 reputation queries move under this same meter — one pricing seam for the whole oracle
product.

## 2. Settlement hooks — bind a contract to a resolution

**Live on Casper testnet.**

| Contract | Package hash |
|---|---|
| `ResolutionHook` | `hash-35e2443be11ac4fed329e216338d702c45bbd8657d8687d1a18a7ed1fc020209` |
| `EscrowConsumer` (worked example) | `hash-eda04741636979fe2456e0554a195047082224ba998012b329c89989959f0dac` |

Source: [`contracts/src/resolution_hook.rs`](../contracts/src/resolution_hook.rs),
[`contracts/src/hook_consumer.rs`](../contracts/src/hook_consumer.rs).
Reference keeper: [`examples/hook-keeper`](../examples/hook-keeper).

### The flow

1. Optionally, `register_hook(market_id)` to subscribe. Permissionless — any address may bind to
   any market. This buys you **event delivery**: a `HookNotified` naming you when the market
   fires. It is not a precondition for anything else, which is why `EscrowConsumer` does not call
   it — the outcome is a public read, so a consumer that polls (or whose keeper polls
   `is_dispatched`) works with `hook_count` at zero. Register when you want to be told; poll when
   you would rather not spend the 3 CSPR.
2. When Hunch finalises the market, the Arbiter calls `dispatch(market_id, decided_outcome,
   bundle_hash)`. That **stores** the outcome and emits `HookNotified` per registered consumer.
3. A keeper — anyone, on their own gas — observes the event (or the flag) and calls your contract.
4. Your contract **reads the outcome back from the hook** and acts on it.

### Step 4 is the one that matters

The obvious design has the keeper pass the outcome in. Do not do that. The `HookNotified` event is
public, so anyone can see a resolution and anyone can call your entry point; if your contract
believes its caller, every keeper is an oracle and the first person to call settles in their own
favour.

Instead, read it:

```rust
#[odra::external_contract]
pub trait ResolutionSource {
    fn is_dispatched(&self, market_id: String) -> bool;
    fn decided_outcome(&self, market_id: String) -> String;
    fn bundle_hash_of(&self, market_id: String) -> String;
}

pub fn settle(&mut self, market_id: String) {          // no outcome argument
    if !self.hook.is_dispatched(market_id.clone()) {
        self.env().revert(Error::NotDispatched);
    }
    let decided = self.hook.decided_outcome(market_id.clone());
    // … pay according to `decided` …
}
```

Now a caller who lies has nothing to lie with. All a keeper can do is pay the gas that makes
settlement happen, which is exactly the authority a relay should have — so you can safely let a
stranger run one, and a keeper outage delays settlement rather than corrupting it.

`EscrowConsumer` is this, complete and deployed: fund an escrow against an outcome, and it pays
the beneficiary or refunds, once, whoever pushes the button.

### Why event dispatch, not a synchronous callback

`dispatch` emits rather than calling consumers back, and that makes two safety properties true by
construction:

- **Reentrancy-free.** The dispatched flag is set (effect) before any event is emitted
  (interaction), and no external contract is called, so there is nothing to re-enter.
- **A failing consumer cannot block settlement.** Your contract reacts in its own transaction, on
  its own gas. One broken integration can never wedge the oracle for everyone.

`dispatch` is idempotent per market (`AlreadyDispatched`), so a retried finalisation cannot
double-fire. On Hunch's side the call runs *after* winners are paid and is structurally unable to
fail a resolution — a hook that reverts, times out, or is unconfigured is logged and absorbed.
Withholding a settled payout because a third party's contract is broken would be exactly backwards.

### Gas

Measured on testnet 2026-08-02 (net cost = deployer purse before − after; see
[GAS.md](GAS.md#oracle-as-a-service--resolutionhook--a-reference-consumer)):

| Call | Who pays | net (CSPR) | limit |
|---|---|---|---|
| `register_hook` | you, once, optional | ~3 (quoted) | 3 |
| `dispatch` | Hunch | **1.319** | 3 |
| `fund` an escrow (payable) | you | **5.861** | 12 |
| `settle` | your keeper | **6.165** | 12 |

The oracle's cost does not grow with the number of protocols bound to it. That is the other reason
for event dispatch — and the measured asymmetry says it plainly: 1.32 CSPR to publish an outcome
for everyone, 6.17 for one consumer to act on it.

`register_hook` is the one row still quoted rather than measured, because nothing on chain has
needed to call it yet — `EscrowConsumer` reads the flag instead of subscribing to the event.

## 3. Proof on chain

The loop above is not a design sketch. On 2026-08-02 it ran end to end on testnet against a real
Hunch resolution — market `testnet:cspr-hourly-updown#20666`, decided `down`, resolved by the
Arbiter in transaction
[`6d968bf5…`](https://testnet.cspr.live/transaction/6d968bf5b0d097c900f97b66c5350ed50a8cc6aa3179cf9649c4785009ce1d6c):

| Step | Transaction |
|---|---|
| Escrow 5 CSPR against outcome `down` | [`43e20702…`](https://testnet.cspr.live/transaction/43e207028aefbc797fe493fc97d55db430cb62c03f45778befd096229703d657) |
| `dispatch` the resolution to the hook | [`1472f9d1…`](https://testnet.cspr.live/transaction/1472f9d11773fbc143851ad0bd9310127af4a5e1a929de8bc73d204313b942b2) |
| `settle` — consumer reads the outcome, pays out | [`6dd95ed3…`](https://testnet.cspr.live/transaction/6dd95ed3b4c054de6f903cda409c36e1cd6a468236018008789fae0dba44ae0e) |

Check it yourself — these are free reads against the deployed hook:

```bash
cd contracts
export HUNCH_RESOLUTION_HOOK=hash-35e2443be11ac4fed329e216338d702c45bbd8657d8687d1a18a7ed1fc020209
cargo run --bin contracts_catalogue -- hook-info 'testnet:cspr-hourly-updown#20666'
```

```
HUNCH_HOOK resolver=entity-account-532eb4f46277143025f3bbdc196b9af543e0b4a4f1ad7e6b6e519cf7898eb1ce
HUNCH_HOOK dispatched=true
HUNCH_HOOK decided_outcome=down
HUNCH_HOOK bundle_hash=sha256:7d73a96395bd0cbd5d1f6dac5a7357413e27f436c19b82a0bf7b22c2923f6f68
```

That `bundle_hash` is the evidence bundle the Arbiter published for the same resolution — the
outcome a consumer settles against and the evidence a human can audit are the same object,
addressed the same way.

**One caveat, stated plainly.** This market resolved at 09:51 UTC, before
`NEXT_PUBLIC_TESTNET_RESOLUTION_HOOK` was wired into the production deployment, so its automatic
dispatch was skipped (the Arbiter logs and absorbs an unconfigured hook — see above) and the
`dispatch` above was pushed manually with the resolver key via `hook-dispatch`, using the outcome
and bundle hash the Arbiter had already published. Same entrypoint, same arguments, same gas limit
the app uses. From the next resolution onward the Arbiter fires it inline and the transaction
appears as `hookDispatchDeployHash` on the `market_resolved` action in
`GET /api/agent/activity`; `/api/health` now raises `contracts.resolutionHook` as a **warn** if the
address is ever unwired again, so a silent skip cannot recur. A warn, not a fail, for the same
reason the dispatch itself is absorbed: an unwired hook costs consumers their notification, and
costs bettors nothing at all. It should be visible on the board, not paged at 3am.
