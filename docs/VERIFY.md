# Verification guide

Everything below is runnable by you, against production, in the order given. Each item says what
to run and what **pass** looks like. Nothing here needs a key you do not already have.

Split into **A. features that existed before this run** (the regression half — these must still
work) and **B. what this run added**.

Live: `https://casper.playhunch.xyz` · Testnet explorer: `https://testnet.cspr.live`

---

## 0. One command that covers the most ground

```bash
curl -s https://casper.playhunch.xyz/api/health | jq '{status, problems}'
```

**Pass:** `status` is `"ok"`. `problems` may list warnings — each one is explained in §C.
`"degraded"` means a `fail`-level check; §C tells you which and what to do.

To see only what is not green:

```bash
curl -s https://casper.playhunch.xyz/api/health | jq '.checks[] | select(.status != "ok")'
```

---

# A. Pre-existing features — these must not have regressed

## A1. The x402 rail still challenges and settles

```bash
curl -s -X POST https://casper.playhunch.xyz/api/agent/v1/bet \
  -H 'content-type: application/json' \
  -d '{"network":"testnet","marketId":"testnet:btc-70k-nov","outcomeKey":"yes","amountMotes":"3000000000","bettor":"01<your-public-key-hex>"}' \
  -i | head -30
```

**Pass:** HTTP **402**, and the body carries `x402Version: 1` with `accepts[0]` containing
`scheme: "casper-x402"`, `asset: "CSPR"`, `maxAmountRequired`, `payTo`, `nonce`, `resource`, plus a
`previewPayoutMotes`. This is the exact shape external agents parse; a change here would be a
breaking change for them.

**Then settle it** by sending `maxAmountRequired` motes to `payTo` from the account you named as
`bettor`, and retrying with the proof:

```bash
PROOF=$(printf '{"scheme":"casper-x402","deployHash":"<your transfer hash>","nonce":"<nonce>"}' | base64)
curl -s -X POST https://casper.playhunch.xyz/api/agent/v1/bet \
  -H 'content-type: application/json' -H "x-payment: $PROOF" \
  -d '{...same body...}' -i | head -20
```

**Pass:** HTTP **200**, a `deployHash` you can open on cspr.live, and an `X-PAYMENT-RESPONSE`
header. **Replay the same proof** → HTTP **402** with "already spent". One payment, one bet.

## A2. MCP still serves the same surface

```bash
claude mcp add --transport http hunch-casper https://casper.playhunch.xyz/api/mcp
```

Then ask Claude to list the tools. **Pass:** 8 tools, including `place_bet` and `get_odds`.
Placing a bet through MCP goes through the same money path as A1 — if A1 passes and MCP lists
tools, the two cannot have drifted (they call one shared function).

## A3. Markets, odds and boards

```bash
curl -s 'https://casper.playhunch.xyz/api/markets?network=testnet' | jq '.markets | length'
curl -s 'https://casper.playhunch.xyz/api/odds?slug=btc-70k-nov' | jq
curl -s 'https://casper.playhunch.xyz/api/boards?network=testnet' | jq '{eventCount, lastBlockHeight}'
```

**Pass:** a non-empty market list; odds that sum to ~1 across outcomes; boards that answer.

## A4. The wide-field market has a bet path

```bash
curl -s https://casper.playhunch.xyz/api/health | jq '.checks[] | select(.name=="contracts.fieldMarket")'
```

**Pass:** `ok`. A `fail` here means the 177-candidate market is open with nowhere to send a bet.

## A5. Human wallet betting

In a browser: open `https://casper.playhunch.xyz`, connect with CSPR.click, and place a small bet.

**Pass:** the header shows your account (no `demo` pill), the wallet prompts you to sign, and the
receipt links to a real transaction on cspr.live. **This is the check that most needs a human** —
the wallet path cannot be exercised from curl.

## A6. Resolution and payouts

```bash
curl -s 'https://casper.playhunch.xyz/api/agent/activity?limit=20' | jq '[.actions[] | select(.kind=="market_resolved")] | length'
```

**Pass:** ≥ 1. Then open any resolved market's page and confirm it shows an evidence bundle hash
and an explorer link.

## A7. The catalogue is bettable, not locked

```bash
curl -s https://casper.playhunch.xyz/api/health | jq '.checks[] | select(.name=="markets" or .name=="bets")'
```

**Pass:** both `ok` — "every catalogued market is bettable on chain" and "every paid bet is
landing on chain".

---

# B. New in this run

## B1. Each agent bets from its own account *(the headline change)*

```bash
curl -s https://casper.playhunch.xyz/api/health | jq '.fleet'
```

Note the four `account` values — they are different accounts. Then, **after a tick has placed
bets**, open any of them on cspr.live:

```
https://testnet.cspr.live/account/<account from .fleet[].account>
```

**Pass:** the agent's own account shows outgoing transactions to the vault. Before this run, every
bet came from the single operator account `01cc9c3d…`.

**Why it matters:** the vault records `env().caller()` as the bettor, so per-agent PnL and
calibration are now recomputable from chain events by anyone, instead of being numbers this server
remembers.

## B2. A dry treasury no longer stops the fleet betting

```bash
curl -s https://casper.playhunch.xyz/api/health | jq '.checks[] | select(.name=="treasury") | .detail'
```

**Pass:** the message reports runway in **hours as well as rounds** (e.g. `~90 round(s), 15h of
runway`) — that phrasing only exists in the new build. When the treasury is low it now says
*market creation and house seeding stop*, not *the economy pauses*, because agents fund their own
bets.

## B3. Bonded agent identity on chain

```bash
curl -s 'https://casper.playhunch.xyz/api/agents/register?network=testnet' | jq
```

**Pass (once the env var in §C1 is set):** `available: true` with the registry package hash.
Until then it answers `available: false` with the reason — which is itself correct behaviour.

Read the registry straight off the chain:

```bash
cd contracts
HUNCH_AGENT_REGISTRY=hash-e226e709c6806bc9e7208e3e421859aa840fc88d27dd3604101426e61d3d9955 \
  cargo run --bin contracts_catalogue -- registry-info
```

**Pass:** `min_bond=100000000000` (100 CSPR), `cooldown_ms=172800000` (48h), and an `agent_count`.

**Full join flow** (needs a funded key of your own):

```bash
curl -s -X POST https://casper.playhunch.xyz/api/agents/register \
  -H 'content-type: application/json' \
  -d '{"network":"testnet","name":"my-agent","metadataUri":"https://example.com/agent.json","bondMotes":"100000000000","agentPublicKeyHex":"01<your-key>"}' | jq
```

**Pass:** a `transactionJson` you sign yourself. The server never takes your key — the registry
bonds whoever signs, so an operator-signed registration would enrol the wrong account.

## B4. The oracle notifies other contracts

Both live on testnet:

| Contract | Package hash |
|---|---|
| `ResolutionHook` | `hash-35e2443be11ac4fed329e216338d702c45bbd8657d8687d1a18a7ed1fc020209` |
| `EscrowConsumer` | `hash-eda04741636979fe2456e0554a195047082224ba998012b329c89989959f0dac` |

```bash
cd contracts
HUNCH_RESOLUTION_HOOK=hash-35e2443be11ac4fed329e216338d702c45bbd8657d8687d1a18a7ed1fc020209 \
  cargo run --bin contracts_catalogue -- hook-info <market-slug>
```

**Pass:** prints the authorised `resolver`, plus `hook_count` and `dispatched` for that market.

**The property worth checking yourself:** `EscrowConsumer::settle(market_id)` takes **no outcome
argument**. Read [`contracts/src/hook_consumer.rs`](../contracts/src/hook_consumer.rs) — it reads
the decided outcome back from the hook, so a keeper cannot influence who gets paid. That is what
makes it safe to let a stranger run the keeper in [`examples/hook-keeper`](../examples/hook-keeper).

## B5. The x402 rail as an installable package

```bash
cd packages/x402-casper && npx tsc -p tsconfig.json && ls dist/x402
```

**Pass:** builds standalone with zero runtime dependencies and emits `index.js` + `index.d.ts`.
[`SPEC.md`](../packages/x402-casper/SPEC.md) documents the wire format precisely enough to
reimplement in another language.

## B6. Measured gas figures

Open [`docs/GAS.md`](./GAS.md). Every figure names the transaction it came from — spot-check any
of them on cspr.live. The headline: **324.27 CSPR** to install a contract per market versus
**3.74 CSPR** to write one as a state entry.

## B7. Claims match the tree

```bash
npx vitest run test/claims-honesty.test.ts
```

**Pass:** 10 tests. They assert that README/VISION do not describe undeployed contracts as live,
that the quoted OdraVM test count matches the actual `#[test]` count, and that OPS.md documents the
custody model the code implements.

---

## Full local suite

```bash
npm run typecheck && npm run lint && npm run test
```

**Pass:** typecheck silent, **0 lint errors** (2 pre-existing warnings), **1993 tests** across 131
files.

```bash
cd contracts && cargo odra test
```

**Pass:** **125 passed**.

> **Note:** vitest needs Node ≥ 22. On Node 21 it crashes at startup inside rolldown with
> `ERR_INVALID_ARG_VALUE ... styleText`. If you see that, you are on the wrong Node — this repo's
> CI uses 22.

---

# C. Known warnings and what to do about them

## C1. `contracts.agentRegistry: warn` — needs two env vars *(your action)*

The contracts are deployed; production has not been told their addresses. `NEXT_PUBLIC_*` values
are **baked in at build time**, so they need a redeploy to take effect.

In the Vercel dashboard → hunch-casper → Settings → Environment Variables, add for **Production**:

```
NEXT_PUBLIC_TESTNET_AGENT_REGISTRY=hash-e226e709c6806bc9e7208e3e421859aa840fc88d27dd3604101426e61d3d9955
NEXT_PUBLIC_TESTNET_RESOLUTION_HOOK=hash-35e2443be11ac4fed329e216338d702c45bbd8657d8687d1a18a7ed1fc020209
```

Then redeploy (Deployments → latest → Redeploy).

**Verify:** `contracts.agentRegistry` turns `ok`, and `/api/agents/register` reports
`available: true`.

## C2. `treasury: warn` — house seeding throttled

Below 144 rounds (~24h) of runway, house seeding turns off; below 48 (~8h), market creation does
too. Betting and resolution keep running. Top up `01cc9c3d…` at
<https://testnet.cspr.live/tools/faucet> to restore full cadence.

This run spent ~1,235 CSPR of the treasury on three contract installs (AgentRegistry 329.43,
ResolutionHook 302.57, EscrowConsumer 303.25, plus the discarded first hook deploy at 297.83).

## C3. `economy: warn` — the tick looks stalled

GitHub Actions `schedule` triggers fire irregularly under load; runs are hours apart in practice
rather than every 10 minutes. It is a platform limitation, not a fault in the app. Force one:

```bash
gh workflow run economy.yml --ref main
```

**Verify:** the `economy` check's action age drops to single-digit minutes.

## C4. Breaker tripped (`bets: fail`)

Only if agents paid and got nothing back. Reset it deliberately:

```bash
curl -X POST https://casper.playhunch.xyz/api/agent/tick \
  -H "x-cron-secret: $CRON_SECRET" -H 'content-type: application/json' \
  -d '{"resetBreaker":true}'
```
