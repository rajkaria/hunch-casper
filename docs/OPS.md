# Operations runbook — Hunch on Casper

Everything needed to run this deployment without reading the source: what each environment
variable does, how to tell whether the system is healthy, what to do when it is not, and what
each on-chain action costs before you pay for it.

Contract deployment itself is covered by [`contracts/DEPLOY.md`](../contracts/DEPLOY.md); this
document is about keeping the running system alive.

---

## 1. The one command that tells you everything

```bash
curl -s https://casper.playhunch.xyz/api/health | jq
```

`GET /api/health` reports mode, contract wiring, KV reachability, x402 posture, signing keys,
cron authorisation, and how long ago an agent last acted. It returns **200** when everything
passes or only warns, and **503** when any check fails — so an uptime monitor can page on the
status code alone, with no body parsing.

| Verdict | Means |
|---|---|
| `ok` | wired and working |
| `skip` | not applicable in this mode (e.g. signing keys in mock mode) |
| `warn` | running, but degraded or on a fallback — worth knowing, not worth paging |
| `fail` | this deployment cannot do its job; overall status becomes `degraded` |

The report never contains a secret's value — only whether one is configured. It is safe to
leave unauthenticated and safe to paste into an issue.

**The four `fail` conditions, and what each one actually breaks:**

| Check | Fails when | Consequence |
|---|---|---|
| `cron` | real mode, no `CRON_SECRET` | every scheduled tick 401s — **the economy stops advancing** |
| `signer.bettor` | real mode, no `CASPER_BETTOR_KEY` | nothing can be signed; every bet and resolve errors |
| `contracts.routing` | real mode, no vault and no per-market addresses | bets and resolves have no on-chain destination |
| `persistence` | KV configured but unreachable (usually a rotated token) | boards silently stop surviving cold starts |

That last one is the trap worth naming: env looks perfect, writes 401 in the background, and
nothing appears broken until an instance recycles. `persistenceConfigured()` only reads env;
the health probe actually calls KV.

---

## 2. Environment matrix

Server-only variables must never be prefixed `NEXT_PUBLIC_` — that prefix ships the value to
the browser. Everything in §2.3 is a secret.

### 2.1 Public network config (`NEXT_PUBLIC_*`)

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_DEFAULT_NETWORK` | `testnet` | Network the UI opens on |
| `NEXT_PUBLIC_CASPER_TESTNET_RPC` | public node | JSON-RPC endpoint |
| `NEXT_PUBLIC_CSPR_CLOUD_TESTNET` | `api.testnet.cspr.cloud` | CSPR.cloud base |
| `NEXT_PUBLIC_CASPER_TESTNET_EXPLORER` | `testnet.cspr.live` | Explorer link base |
| `NEXT_PUBLIC_TESTNET_MARKET_FACTORY` | — | MarketFactory package hash |
| `NEXT_PUBLIC_TESTNET_ORACLE_REGISTRY` | — | OracleRegistry package hash |
| `NEXT_PUBLIC_TESTNET_VAULT` | — | v1 ParimutuelMarket vault (fallback routing) |
| `NEXT_PUBLIC_TESTNET_VAULT_V2` | — | **HunchVault v2** singleton — cheap `create_market` entries |
| `NEXT_PUBLIC_TESTNET_MARKET_ADDRS` | — | JSON `{slug: "hash-…"}`; per-market packages, **outrank** the vault |
| `NEXT_PUBLIC_ONCHAIN_RECEIPTS` | — | JSON `[{label, hash, network}]` rendered as explorer links |
| `NEXT_PUBLIC_SHOW_DEMO_RESOLVE` | off | Shows the manual operator resolve control |
| `NEXT_PUBLIC_CSPR_CLICK_APP_ID` | — | CSPR.click app id; with the SDK loaded, real wallets sign |

`NEXT_PUBLIC_MAINNET_*` mirrors every testnet key.

> **Routing order matters.** `NEXT_PUBLIC_*_MARKET_ADDRS` wins over `_VAULT_V2` for any slug it
> contains. Dropping a slug from that map silently re-routes its bets to the vault, where the
> market may not exist. When rebuilding the map, use `contracts_catalogue list-markets` (free
> reads) as the source of truth rather than a saved copy.

### 2.2 Mode and behaviour

| Variable | Default | Purpose |
|---|---|---|
| `CASPER_CHAIN_MODE` | `mock` | `real` signs and submits live transactions |
| `CASPER_LIVE_SIGNALS` | unset | `false` forces the deterministic Genesis rotation |
| `CASPER_ENABLE_RESOLVE_ROUTE` | `true` | Operator resolve route; **fail-closed in real mode** |
| `GENESIS_MAX_CREATED` | `12` | Cap on demo-triggered Genesis creations |
| `CASPER_PROPHETS_PER_TICK` | 1 real / all mock | Prophets betting per tick (§5 economics) |
| `CASPER_CREATION_BOND_MOTES` | `1000000000` | Bond attached per created market; refunded at settlement |
| `CASPER_HOUSE_SEED_DIVISOR` | `500` | Scales catalogue seed pools for real-mode house liquidity |
| `LLM_MODEL` | `anthropic/claude-sonnet-5` | Narration model (never the money path) |

### 2.3 Secrets

| Variable | Required when | Purpose |
|---|---|---|
| `CASPER_BETTOR_KEY` | real mode | Ed25519 PEM or hex seed that signs and funds transactions |
| `CASPER_ORACLE_KEY` | recommended in real mode | Separate resolve signer; falls back to the bettor key (shared custody) |
| `CRON_SECRET` | real mode | Authorises the scheduled tick; **without it the economy stops** |
| `CASPER_RESOLVE_OPERATOR_TOKEN` | if the resolve route is enabled in real mode | `x-operator-token` header value |
| `CASPER_X402_PAYTO` | real-mode agent x402 | Treasury account; wires the transfer-verifying PaymentPort |
| `CASPER_REAL_AGENT_X402` | legacy alternative | `true` keeps the weaker nonce-match verifier |
| `CASPER_FLEET_SEED` | real-mode fleet | Derives one Ed25519 identity per agent (§5) |
| `CASPER_PROPHET_KEY_<AGENT>` | optional | Explicit key for one agent; overrides derivation |
| `HUNCH_BOTS_LIVE` | to post from bots | `true` unlocks outbound Telegram/X posts (§9); default off |
| `TELEGRAM_BOT_TOKEN` | live Telegram bot | @BotFather token that authenticates `sendMessage` (§9) |
| `TELEGRAM_WEBHOOK_SECRET` | recommended | Shared secret Telegram echoes on each webhook (§9) |
| `X_BOT_BEARER_TOKEN` | live X bot | Token authorised to create reply tweets (§9) |
| `X_WEBHOOK_SECRET` | optional | Shared secret gating the X webhook (§9) |
| `NEXT_PUBLIC_SITE_URL` | optional | Overrides the base URL in embed/oEmbed/bot links |
| `CASPER_ORACLE_ACCOUNT` | real-mode creation | Oracle bound to Genesis markets — **public**, not a secret |
| `CSPR_CLOUD_API_KEY` | optional | Live validator signal for Genesis |
| `LLM_API_KEY` | optional | Narration; absent ⇒ deterministic canned narration |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | production | Economy persistence (Vercel KV names win) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | production | Same, plain Upstash names |

**Vercel gotcha (cost us a session once):** this project's variables are *sensitive-type*.
`vercel env pull` renders them as `""` on CLI ≤ 54 and `[SENSITIVE]` on ≥ 56 — **never** trust a
pull to tell you whether a variable is set. Ask `/api/health` instead; it reports presence from
inside the running deployment.

### 2.4 Repository-level (GitHub)

| Setting | Kind | Purpose |
|---|---|---|
| `ECONOMY_BASE_URL` | repo *variable* | Target for the 10-minute tick (default `https://casper.playhunch.xyz`) |
| `CRON_SECRET` | repo *secret* | Sent as `x-cron-secret`; omitted when unset |

---

## 3. The economy heartbeat

`.github/workflows/economy.yml` POSTs `/api/agent/tick` every 10 minutes — GitHub Actions rather
than Vercel cron, because the Hobby plan fires cron at most once a day.

- `schedule` only fires from the **default branch**. The workflow must be on `main` to run.
- `workflow_dispatch` works from any branch for a manual kick.
- To stop the loop: disable the workflow in the Actions tab (or delete the file).

**Symptom → cause:**

| Symptom | Likely cause |
|---|---|
| Health `economy` warns "tick looks stalled" | workflow disabled, `ECONOMY_BASE_URL` wrong, or every run 401ing |
| Every workflow run logs HTTP 401 | real mode with `CRON_SECRET` missing or mismatched between repo and deploy |
| Ticks succeed but boards reset | KV unconfigured or unreachable — check `persistence` in health |

A tick is idempotent in the sense that matters: it places the round's bets and resolves matured
markets. Re-running one produces another round, not a duplicate of the last.

---

## 4. Costing an on-chain action before paying for it

Casper testnet runs `payment_limited` pricing with 75 % refund of the unused limit, so a
transaction costs **`consumed + 0.25 × (limit − consumed)`**. Over-setting a limit is not free,
and the *whole* limit must be affordable when the transaction is submitted.

`plan-cost` prices a catalogue run with no node, no key, and no deployed contracts — it is pure
arithmetic over measured consumption:

```bash
curl -s 'https://casper.playhunch.xyz/api/deploy-plan?network=testnet' > /tmp/plan.json
cd contracts
cargo run --bin contracts_catalogue -- plan-cost /tmp/plan.json v2 all 100
# modes: v2 (vault exists) | v2-fresh (also installs the vault) | v1 (per-market installs)
# args:  <manifest> <mode> <slug,...|all> <seed-divisor> [bond-motes]
```

It prints a per-step table plus five machine-readable lines:

| Line | Meaning |
|---|---|
| `HUNCH_PLAN_COST_EXPECTED_MOTES` | what the run should actually cost |
| `HUNCH_PLAN_COST_WORST_MOTES` | every call reverts and burns its full limit |
| `HUNCH_PLAN_BOND_ESCROW_MOTES` | creation bonds — escrowed, refunded at clean settlement |
| `HUNCH_PLAN_PEAK_TX_LIMIT_MOTES` | balance floor the node enforces on the largest single call |
| `HUNCH_PLAN_RECOMMENDED_BALANCE_MOTES` | expected + bonds + one peak limit of headroom |

Fund to the **recommended** figure, not the expected one. Running dry mid-catalogue strands
half-created on-chain state (a created market with no registration, a bond posted against
nothing) that then has to be reconciled by hand.

Measured per-transaction costs (net CSPR, from the Jul 5 bootstrap and Jul 18 vault-v2 runs) live
in [`contracts/DEPLOY.md` §4c](../contracts/DEPLOY.md) and in the constants at the top of
`contracts/bin/catalogue.rs`. The estimator derives from those constants, so retuning a gas limit
updates the estimate automatically.

### Faucet refill

The Casper testnet faucet is **human-only** (no API). Refill at
<https://testnet.cspr.live/tools/faucet> with the deployer public key from
`contracts/keys/public_key_hex`, then confirm:

```bash
cd contracts && cargo run --bin contracts_catalogue -- balance
```

---

## 5. The Prophet fleet's wallets

Each Prophet is a funded Casper identity that pays its own x402 bills. Its bet is preceded by a
genuine CSPR transfer to `CASPER_X402_PAYTO`, and that transfer's hash *is* the payment proof —
verifiable by anyone against the chain, without trusting this server.

### Key layout

One secret, N identities: `HMAC-SHA256(CASPER_FLEET_SEED, "hunch-fleet-v1:<agentId>")` is each
agent's Ed25519 secret key. Derivation is deterministic across restarts, redeploys, and
instances — an address that drifted between deploys would strand its balance. A per-agent
`CASPER_PROPHET_KEY_<AGENT>` overrides derivation for an agent whose key needs separate custody.

### Stake sizing is bounded by the chain, not by taste

Every agent bet settles as a **native CSPR transfer**, and Casper's chainspec rejects native
transfers below `core.native_transfer_minimum_motes` — **2.5 CSPR** on testnet. A Prophet sized
below that floor does not bet small; it cannot bet at all, and the node answers `-32016
insufficient transfer amount` every round while the fleet merely looks idle. Stakes are 4/3/3/3
for exactly this reason. `config/network.ts` owns the constant, `real-wallet.transfer` refuses a
sub-floor amount by name before submitting, and `test/prophet-strategies.test.ts` fails CI if any
Prophet — including Momentum's doubled conviction bet — drops under it.

**A single shared key is not supported, deliberately.** All four Prophets would be the same
on-chain account, and every track record the reputation layer depends on — PnL, calibration,
per-category expertise — would collapse into one indistinguishable blob.

### Refilling

```bash
# 1. Who needs money? (also shows each agent's balance and funded verdict)
curl -s https://casper.playhunch.xyz/api/health | jq '.fleet'

# 2. Top them all up from the deployer, 300 CSPR each.
ACCOUNTS=$(curl -s https://casper.playhunch.xyz/api/health | jq -r '[.fleet[].accountHash] | join(",")')
cd contracts && cargo run --bin contracts_catalogue -- fleet-fund 300 "$ACCOUNTS"
```

`fleet-fund` refuses to start unless the deployer can cover every transfer plus gas, so a partial
refill never leaves half the fleet funded and you guessing which half. Accounts are passed in
explicitly rather than re-derived in Rust: a second implementation of the KDF would be a second
thing to keep in sync, and a divergence would fund addresses no agent signs for — indistinguishable
from a successful refill until the fleet goes quiet anyway.

### What real mode costs per day

Every figure below is net CSPR under testnet's 75 % refund model
(`consumed + 0.25 × (limit − consumed)`), from the measured transactions in
[`contracts/DEPLOY.md` §4c](../contracts/DEPLOY.md).

| Call | Consumed | Limit | Net |
|---|---|---|---|
| `bet` (operator escrow) | 1.439 | 5 | **2.33** |
| `resolve` | 6.317 | 12 | **7.74** |
| `create_market` (typical) | 2.323 | 8 | **3.74** |
| agent x402 transfer | fixed | 0.1 | **0.10** |

At the 10-minute tick (144 ticks/day), with **one** Prophet per tick:

| Line | Per day |
|---|---|
| Prophet bet escrow gas (144 × 2.33) | ~336 CSPR (treasury) |
| Prophet x402 transfer gas (144 × 0.10) | ~14 CSPR (fleet purses) |
| Prophet stakes | 3–4 CSPR/tick (8 when Momentum doubles down), reimbursed to the treasury by the x402 transfer |
| Resolutions | 7.74 CSPR each, only when a market matures |

**Four Prophets per tick would be ~1,340 CSPR/day in escrow gas alone** — far past what a
faucet-funded deployer can hold. That is why real mode defaults to one Prophet per tick and
rotates which one acts; every agent still takes its turns and the pools still move between rivals
across the hour. `CASPER_PROPHETS_PER_TICK` raises it if you have funded for more.

To stretch a fixed budget further, lower the tick frequency in
`.github/workflows/economy.yml` (hourly ≈ 56 CSPR/day) before raising the fleet size.

### Automatic throttling

The tick reads the purses before it spends anything and degrades in a fixed order, so a nearly
empty economy never reaches the state where every transaction reverts for insufficient funds and
burns its gas on the way — a broke economy would otherwise drain *faster* than a healthy one.

| Treasury runway | Effect |
|---|---|
| ≥ 144 rounds (~24 h) | full cadence |
| < 144 rounds | **house seeding off** — most expensive per unit of value, most replaceable |
| < 48 rounds (~8 h) | **market creation off** — the catalogue stops growing; live markets keep trading |

| Fleet runway (poorest agent) | Effect |
|---|---|
| ≥ 12 rounds (~2 h) | Prophets bet |
| < 12 rounds | **betting off** — last, because an economy that stops betting looks dead |

**Resolution is never throttled.** It pays people what they are owed and refunds creation bonds;
withholding it to save gas would strand user money to protect the operator's. Each capability is
gated by the purse that actually pays for it, so a full treasury cannot mask a starving fleet.
The tick logs `[economy] throttled: …` with the runway numbers whenever it is not at full cadence.

### Running dry

An agent below its **turn floor** (largest stake at full conviction + transfer gas, one number
shared by the health endpoint and the cadence planner — `prophetTurnCostMotes`) skips its turn and logs a
warning. This is correct behaviour, not a fault: submitting a transfer it cannot pay for would
burn gas to produce a failed transaction and an unverifiable proof. Health reflects it:

| Health `fleet` | Means |
|---|---|
| `ok` | every purse clears the turn floor |
| `warn` | some agents are sitting rounds out — named in the detail |
| `fail` | **every** purse is below the floor; the fleet has stopped betting entirely |
| `skip` | no fleet wallet wired (mock mode, or real mode with no seed) |

### Why a bet costs two transactions

The agent transfers its stake to the treasury (its x402 payment); the operator key escrows the
same amount into the vault. Since the treasury and the escrow funder are the same operator
account, the operator is reimbursed exactly and the agent pays exactly once. The agent's identity
is proven by the *transfer*, which is what the reputation layer indexes — not by who submitted the
escrow. See the decision journal for why the alternative (the agent signing its own escrow) would
charge the agent twice.

---

## 6. Boards you do not have to trust

`/api/agent/leaderboard` serves the in-process boards. `/api/boards` folds the vault's own event
log through the same pure payout engine the contract pays from, so the same numbers arrive by a
route anyone can recompute from the chain. The meta-markets settle against these boards, which is
why one path was not enough.

```bash
curl -s '.../api/boards?network=testnet' | jq '{agentPnl, provenance}'
```

`provenance` reports how many events were folded, from which block, and **what was skipped and
why**. A silent skip is how an event-derived board drifts from the chain while still looking
healthy, so nothing is dropped quietly. The commonest reason — `no market_created` — means the
read started mid-history; lower `?from=` and refold.

Streaming comes from CSPR.cloud SSE with polling as the fallback. The fallback is not optional: a
subscription that silently does nothing is indistinguishable from a quiet chain. Without
`CSPR_CLOUD_API_KEY` the feed is unauthenticated and will mostly return nothing — health reports
this under `signals`.

### Agent reputation

`GET /api/agents/<id>/reputation` (and the MCP `get_agent_reputation` tool) answers "how good is
this agent, really?" from the same event log. It leads with **calibration, not PnL**:

| Field | Read it as |
|---|---|
| `calibration.brier` | mean squared forecast error — **lower is better**, 0 perfect, 1 maximally wrong |
| `calibration.skillBps` | `1 − brier/0.25` in bps; positive beats a coin flip, negative is worse than one |
| `calibration.sampleCount` | how much evidence the score rests on — **check this before ranking** |
| `manipulationSignals` | evidence for a human decision, never a verdict |

An agent with no history returns **404**, not a zero score: "never bet" and "perfectly calibrated"
must not look the same to a consumer.

`AgentRegistry` (`contracts/src/agent_registry.rs`) holds the on-chain half: a CSPR bond buys an
identity, deactivation starts a cooldown during which the bond stays slashable, and slashing is
admin-gated with an explicit reason code. The cooldown is what stops an agent deactivating the
moment a bad bet settles, reclaiming its stake, and re-registering clean.

---

## 7. Persistence

The four economy ledgers (settlement, activity feed, oracle reputation, Genesis-created markets)
are module singletons. Without KV they reset on every serverless cold start and diverge across
instances — a visitor's bet can vanish when the next request lands elsewhere.

With KV configured, all four fold into one versioned envelope under `hunch:economy:v1`:
hydrated once per instance before the first read, snapshotted after every mutation (debounced,
coalesced), last-write-wins across instances. The chain remains the source of truth for money;
this is durability for the *presentation* layer.

Failure behaviour is deliberate: a 3-second timeout, one warning, then the app continues on
in-memory state. **KV downtime degrades durability, never availability.**

- Verify: `curl -s .../api/health | jq '.checks[] | select(.name=="persistence")'`
- Hydration marks the demo seed as done, so a hydrated instance never fabricates demo history on
  top of real history.
- To wipe demo state, delete the `hunch:economy:v1` key; the next cold instance re-seeds.

---

## 8. Incident checklist

1. **`curl /api/health`** — it names the failing subsystem. Start there, not in the logs.
2. **Boards empty / history vanished** → `persistence`. Configured but unreachable is a rotated
   token; unconfigured in production is a missing setup step.
3. **Economy frozen** → `cron`. Check the Actions tab for red runs; 401s mean the secret does not
   match between the repo and the deployment.
4. **Agent bets return 402** → `x402`. In real mode the rail is fail-closed unless
   `CASPER_X402_PAYTO` (preferred, transfer-verifying) or `CASPER_REAL_AGENT_X402=true` (weaker)
   is set. A 402 here is correct behaviour, not a fault.
5. **Bets error in real mode** → `signer.bettor` or `contracts.routing`. No key means nothing can
   be signed; no routing target means there is nowhere to send it.
6. **Transactions rejected for funds** → run `balance`, then `plan-cost`, then refill (§4).
7. **Roll back fast:** set `CASPER_CHAIN_MODE=mock` and redeploy. The surface returns to the
   deterministic, credential-free demo — labelled `simulated`, honest, and always available.
   This is the safe state, and reaching for it is not a failure.

---

## 9. Distribution: chat bots + embeds

The Telegram and X bots and the embeddable odds widget let people bet where they already are.
**They ship OFF.** Nothing is posted in your name until you deliberately turn it on — decision D2
of the roadmap run. Everything below is built, tested, and one operator command away.

### What runs without any configuration

- `GET /embed/<slug>` — a chrome-free, self-contained odds widget (no client JS, no secrets,
  cacheable, `frame-ancestors *`). Embed it anywhere with
  `<iframe src="https://casper.playhunch.xyz/embed/<slug>"></iframe>`.
- `GET /api/oembed?url=<market-url>` — the oEmbed provider, so Slack/Discord/CMS unfurl a market
  link into that widget. Returns a `rich` card; `format=xml` is intentionally unimplemented (501).
- `POST /api/bots/telegram` and `POST /api/bots/x` — the webhooks. In the default (not-live) state
  they parse an update, run the full command handler (parse → dedupe → bet → reply) against the
  configured chain mode, and **record** the reply instead of posting it. You can exercise the whole
  bot locally by POSTing a webhook body and reading the reply back — zero external posts.

The command grammar (`src/core/bot-command.ts`) is strict and exhaustively tested:
`bet <amount> [CSPR] <outcome> on <slug>`, plus `odds <slug>`, `markets [n]`, `help`. Every bet is
deduped by the platform's message id (`bot-idempotency.ts`), so a retried webhook never double-bets.

### Turning the bots live (deliberate, per platform)

1. **Chain readiness.** A live bet uses the same x402 money path as the REST/MCP rails. In real
   mode that means `CASPER_X402_PAYTO` must be set (see §2.3) or the rail fails closed. In mock mode
   the bots place deterministic demo bets — fine for a demo channel, never for real stakes.
2. **Master switch.** `HUNCH_BOTS_LIVE=true`. Without it, every `send()` refuses — this is the
   single gate that keeps a misconfigured deploy from posting.
3. **Telegram.** Create a bot with @BotFather → set `TELEGRAM_BOT_TOKEN`. Register the webhook:
   ```bash
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d url=https://casper.playhunch.xyz/api/bots/telegram \
     -d secret_token=$TELEGRAM_WEBHOOK_SECRET
   ```
   Set `TELEGRAM_WEBHOOK_SECRET` to the same value here and above; the route rejects any update
   that doesn't echo it.
4. **X.** Set `X_BOT_BEARER_TOKEN` (a token authorised to post) and register the mention webhook to
   `https://casper.playhunch.xyz/api/bots/x` (the `GET` handler answers the CRC challenge). Optional
   `X_WEBHOOK_SECRET` gates inbound calls via the `x-webhook-secret` header.
5. **Narrated alerts (optional).** `broadcastTickAlerts` (`src/lib/alerts.ts`) turns a tick's big
   pool moves and resolutions into narrated pushes. It is deliberately **not** wired into the money
   -moving tick — call it from an alerting cron with a broadcast chat id so a narration fault can
   never break settlement.

**To roll back:** unset `HUNCH_BOTS_LIVE`. Sends immediately revert to record-only; nothing posts.

---

## 10. Deploy pipeline

- **Production (app):** push to `main` → Vercel builds and promotes to `casper.playhunch.xyz`.
- **CI gate:** `.github/workflows/ci.yml` runs `pnpm typecheck && lint && test && build`, plus
  `cargo odra test` and a wasm build in a second job.
- **SDK:** `pnpm sdk:build`, then `cd packages/sdk && npm publish --access public`.

### Mainnet contract deploy — dry run FIRST, then a deliberate spend

The mainnet deploy of the contracts is an operator action that spends real CSPR, so it is never
automated. Always preview it:

```bash
# The full cost + address plan, zero transactions (transactionsPerformed:false):
curl -s https://casper.playhunch.xyz/api/deploy-plan/mainnet-preflight?format=text
```

The preflight prints every install + `create_market` + `register_market` (+ optional house seed)
with chain-measured net costs and a grand total, the address plan (already-deployed vs to-deploy),
and the **audit gate**: while `NEXT_PUBLIC_AUDIT_STATUS` is not `audited` it reports **NOT CLEARED**
and the per-bet cap stays at the unaudited ceiling. There is deliberately no path from this endpoint
to a signed transaction.

Only after (1) an independent audit closes, (2) `NEXT_PUBLIC_AUDIT_STATUS=audited` is set, and (3)
you have reviewed the preflight, do you run the real deploy with a funded `CASPER_BETTOR_KEY`
against the mainnet node via `contracts/bin/cli.rs` (odra-cli livenet) + the catalogue driver in
`contracts/bin/catalogue.rs` — see [`contracts/DEPLOY.md`](../contracts/DEPLOY.md). That is a
separate, deliberate command; this run does not execute it (decision D2).

---

## 11. Feed economics (S27)

The probability feed (`/api/odds`) and the oracle query API (`/api/oracle/query`) are metered by one
shared meter (`lib/query-meter.ts`): a free ecosystem tier per caller per hour, then x402 per call.

- **Marginal cost of a feed read** ≈ the cost of a cache-fronted GET. `/api/odds` sets
  `s-maxage=30` and `/api/odds/history` `s-maxage=300`, so a widely-embedded or high-traffic feed is
  served from the edge and barely touches the origin. The number itself is already computed for the
  UI — the feed adds no new money-path cost.
- **Revenue** is the paid-tier x402 (`ORACLE_PAID_QUERY_MOTES`, default 0.1 CSPR) on calls past the
  free allowance (`ORACLE_FREE_QUERIES_PER_HOUR`, default 20). Tune both to the ecosystem's appetite;
  a generous free tier is a distribution investment, the paid tier monetises heavy programmatic use.
- **Public-good markets** (Condor upgrade, validator health, grant milestones) are seeded from house
  liquidity like any catalogue market. Their return is ecosystem signal, not fee revenue — price the
  seed as marketing, not as a position expected to profit.

See [`docs/FEEDS.md`](FEEDS.md) for the response contracts and the calibration export.

The local pre-commit gate is the same command CI runs:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
cd contracts && cargo odra test   # only when contracts/ changed
```
