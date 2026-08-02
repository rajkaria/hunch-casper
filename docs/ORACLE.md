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

1. Your consumer contract calls `register_hook(market_id)` once to subscribe. Permissionless —
   any contract may bind to any market.
2. When Hunch finalises the market, the Arbiter calls `dispatch(market_id, decided_outcome,
   bundle_hash)`. That **stores** the outcome and emits `HookNotified` per registered consumer.
3. A keeper — anyone, on their own gas — observes the event and calls your contract.
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

| Call | Who pays | Budget |
|---|---|---|
| `register_hook` | you, once | ~3 CSPR |
| `dispatch` | Hunch | 3 CSPR limit |
| `settle` (your contract) | your keeper | ~5 CSPR |

The oracle's cost does not grow with the number of protocols bound to it. That is the other reason
for event dispatch.
