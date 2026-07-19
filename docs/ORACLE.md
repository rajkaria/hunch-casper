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

`contracts/src/resolution_hook.rs`

1. Your consumer contract calls `register_hook(market_id)` once to subscribe.
2. When Hunch finalises the market, the authorised resolver calls `dispatch(market_id, outcome,
   bundle_hash)`, which emits a `HookNotified` event per registered hook.
3. Your keeper/relayer observes the event and calls your consumer's `on_resolution(...)`.

**Why event-driven, not a synchronous callback:** it is reentrancy-free, and a consumer that would
revert can never block Hunch's settlement — one broken integration can't wedge the oracle for
everyone. `dispatch` is idempotent per market, so a retried finalisation never double-fires a hook.
See the module docs for the full rationale.

### Reference integration

`examples/oracle-consumer/` ships the launch case study:
- `src/consumer.rs` — a minimal Odra consumer that binds to a resolution and acts on the outcome
  (idempotent, relayer-authenticated);
- `client.ts` — how to *buy* an answer over the x402-metered query API, handling the 402 upgrade.

These are reference/documentation code, not part of the deployed contract set.

## 3. Trust model

Every answer is auditable end to end: the recipe hash pins the rule (immutable once the first bet
lands), the evidence-bundle hash pins the snapshot + reasoning, and the replay harness
(`src/core/resolution-replay.ts`) reproduces the winner from them. Buy the answer, verify the math.
The oracle's reputation is the price signal; the evidence is the proof.
