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
| `NEXT_PUBLIC_CSPR_CLICK_APP_ID` | to let humans bet | CSPR.click app id. Setting it is the ENTIRE activation — the app loads the bundle itself (§3b) |
| `BET_TICKET_SECRET` | falls back to `CRON_SECRET`, then `CASPER_BETTOR_KEY` | HMAC key binding a prepared wallet-signed bet to its transaction hash (§3c). Server-only |

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

### 3b. Letting humans bet (CSPR.click)

Until `NEXT_PUBLIC_CSPR_CLICK_APP_ID` is set, every visitor gets the labelled demo wallet and
**no human can place a real bet**. That is the single hard blocker on human traction.

The connector seam (`src/lib/wallet-connector.ts`) reads `window.csprclick` and falls back to the
demo account; `src/components/csprclick-script.tsx` loads the bundle. Both halves matter — for a
long time the seam was complete and nothing loaded the bundle, so `available()` was always false
and the app was configured-but-inert. `test/csprclick-activation.test.ts` pins that both are
required.

**The loader exists after all — it is just not on npm.** An earlier revision of this runbook
concluded there was no drop-in `<script>` and made the URL operator-supplied with no default. Half
of that was right; the half that was wrong kept the wallet dead even after an app id was set.

Re-probed 2026-07-25, by download rather than assertion:

| Thing | Reality |
|---|---|
| `cdn.jsdelivr.net/npm/@make-software/csprclick-ui@1/…` (was hardcoded) | **HTTP 404**, always was. No `1.x` of that package was ever published. |
| `@make-software/csprclick-ui@2.1.0` | A **React component library**. No UMD build; peer-depends on **React 18.3.1** (this app runs 19). Mounts a navbar into `#csprclick-navbar`. |
| `@make-software/csprclick-core-client@1.11.0` | **`.d.ts` files only** — 5.7 KB, zero runtime JS, despite declaring `main: "./index.js"`. Its README says so outright. |
| **`cdn.cspr.click/latest/csprclick-sdk-2.1.js`** | **HTTP 200, 1,439,314 bytes, `text/javascript`.** The plain SDK. Installs `window.csprclick`, no React needed. This is now the default. |
| `accounts.cspr.click/signin.html` | **HTTP 404 (nginx).** The page the SDK's own `popup` mode opens — CSPR.click deleted it. |
| `accounts.cspr.click/v2.1/index.html`, `/wallet-ui/sign.html` | **200.** The core frame and signing UI that `iframe` mode uses. |

Two non-obvious things that make the difference between a working wallet and a silent no-op, both
now handled in `src/config/csprclick.ts`:

- **`window.csprClickSDKAsyncInit` must be defined before the SDK script runs.** Its last statement
  is `typeof window.csprClickSDKAsyncInit == "function" ? (window.csprclick = new Sdk, …) :
  console.log("CSPRClickSDK not requested.")`. This app used to publish `__CSPR_CLICK_APP_ID__` and
  `__CSPR_CLICK_OPTIONS__` instead — two globals that appear **zero** times in the SDK.
- **`contentMode` is `iframe`/`popup`, not the network.** The network is `chainName`
  (`casper-test`/`casper`), which was never being sent. Sending the network as `contentMode` stored
  a non-member of the enum and quietly disabled every `contentMode ==` comparison.

Sign-in itself goes through `connect(providerKey)`, not `signIn()` — see `wallet-connector.ts` for
why (both `signIn()` branches are dead without CSPR.click's React package).

**A third thing, and the one visitors actually reported:** `connect()` opens with
`if (this.shouldRedirectToInAppBrowser(e)) return`, which for `casper-wallet` opens
`casperwallet.io/download?browse=<this page>?click=connect` in a new tab and swallows the connect —
whenever the SDK reads the device as mobile. Its test is
`/iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints >= 1) ||
/(android)/i.test(ua)`, evaluated **before** the provider is consulted, so an installed, unlocked,
already-connected extension gets redirected past all the same — the symptom being a download tab
and a page that still says "Connect wallet". The same `||` is in the provider's own `IsPresent()`,
which answers true on a mobile-looking UA whether or not a wallet exists anywhere.

**And a fourth, for the visitor who has no extension at all:** WalletConnect's `IsPresent()` is
`return !0` — always true — so it wins the provider race for every desktop visitor without an
extension, and its connect path does not open anything. It emits

```
triggerCustomEvent(PROVIDER_STATUS_UPDATE, { status: ShowPairingQR, pairingUri: uri })
```

and waits. The SDK has **no subscribe method** — every provider dispatches
`new CustomEvent("csprclick", {detail})` on `window` — so an app that adds no listener sees
nothing, shows nothing, and ships a Connect button that silently does nothing.

That route is now built rather than avoided:

- `subscribeToCsprClick()` / `parseCsprClickEvent()` read the channel: the pairing URI, the
  accounts a paired wallet shares (`account-list-updated`), `user-rejected-pairing`,
  `error-connecting-wallet` — plus the extension's own `…:connected` events, which carry the
  account in `detail.activeKey`.
- `src/components/wallet-pairing.tsx` renders the URI as a QR (encoder: `src/lib/qr-code.ts`, no
  dependency), with a `casperwallet://wc?uri=…` deep link, a copy button, an account picker when a
  wallet shares several, and a cancel that aborts the attempt.
- Pairing alone connects nothing: WalletConnect's `connect()` resolves `undefined`, and the app
  must hand one of the shared accounts back through `signInWithAccount()`.
- `no-wallet` now means what it says — the SDK reports no provider present at all — and is shown as
  a message with an install link, never as silence.

Mobile needs no QR: on an iOS/Android UA the SDK deep-links `casperwallet://wc?uri=…` itself, so
the dialog stays on "Waiting for your wallet" (with a cancel) until the app returns.

`wallet-connector.ts` therefore treats `typeof window.CasperWalletProvider === "function"` as the
only evidence a wallet is installed, and disarms `shouldRedirectToInAppBrowser` for exactly one
`connect()` call when it is. When no extension is injected the handoff is left alone — on a real
phone the Casper Wallet in-app browser genuinely is the only route — and `<WalletResume />` picks
up the `?click=connect` marker on the way back so the round trip finishes on its own.

**To activate:**

1. Register the app at <https://console.cspr.click> and copy the app id. CSPR.click issues a
   **different id per network** — take both if you plan to serve both. The id must come from the
   console; there is no format to guess. Prove it exists before deploying it:

   ```bash
   curl -si -H "Origin: https://casper.playhunch.xyz" \
     https://accounts.cspr.click/api/application/<APP_ID>.json | head -1
   ```

   `HTTP 200` or it is not an app id. An unregistered value answers
   `401 {"error":{"message":"wrong application id"}}` — and the SDK's `init()` crashes **unhandled**
   on that body (`e.menu_items.map` on an error object), emits no event, and never installs its
   signing frame. The only browser symptom is an uncaught
   `TypeError: Cannot read properties of undefined (reading 'map')` from `csprclick-sdk-2.1.js`
   next to the 401. This shipped: prod ran for days with a made-up id, posture `armed`, and a
   Connect that could never sign. The app now probes this same endpoint on page load and on
   `/api/health` — a rejected id demotes every visitor to the labelled demo wallet (with the
   reason under the bet panel) and turns the `wallet` health check into a **fail** instead of a
   green lie.
2. `vercel env add NEXT_PUBLIC_TESTNET_CSPR_CLICK_APP_ID production` (and
   `NEXT_PUBLIC_MAINNET_CSPR_CLICK_APP_ID` if you have it). `NEXT_PUBLIC_CSPR_CLICK_APP_ID` still
   works as a single shared fallback — but **remove it once a network-specific id is set, and never
   leave a placeholder in it or in the mainnet var.** It falls back for *both* networks, so a stale
   value there is not dormant: on 2026-07-26 prod held a never-issued id in the shared var beside a
   correct testnet id, the SDK booted on the good id, and the client probe asked about the stale one
   — a wrong-id verdict that demoted every visitor to the demo wallet with a green `/api/health`
   (server-side resolution was network-aware, the connector's was not). Both are network-aware now;
   the shipped value is verifiable from the browser bundle:
   `curl -s https://<domain>/ | grep -o '__CSPR_CLICK_APP_ID__=[^;]*'`.
3. In the console, whitelist what the wallet actually calls — REST `/accounts/**` and `/rates/**`;
   RPC `account_put_deploy`, `account_put_transaction`, `info_get_deploy`, `info_get_transaction`,
   `query_balance`. Leave the rest off; server-side chain reads use `CSPR_CLOUD_API_KEY`, not this.
4. **Nothing to do for the loader** — `NEXT_PUBLIC_CSPR_CLICK_BUNDLE_URL` now defaults to the
   verified CDN URL above. Set it only to pin a version or self-host.
4b. For the QR pairing route (any visitor without an extension), mint a **WalletConnect Cloud
   project id** at <https://cloud.reown.com> and set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`. The
   SDK's WalletConnect provider throws `"WalletConnect settings not present"` unless `init()`
   carries `walletConnect: {projectId}` — found live 2026-07-26: with a valid app id and no
   project id, a desktop without an extension got "Could not establish a connection with the
   provider" instead of a QR. Unset, the app now simply does not offer WalletConnect and shows
   the install prompt instead; the extension route is unaffected either way.
5. Redeploy. `NEXT_PUBLIC_*` vars bake at build time, so the currently-running build will not pick
   it up.
6. Verify: `/api/health` → the `wallet` check reads **ok and "accepted by accounts.cspr.click"**
   (the report now live-probes the id; `fail` names the 401 and this section). In the browser console,
   `typeof window.csprclick` must be `"object"` and `window.csprclick.chainName` must match the
   network; if it is `undefined`, check the devtools console for "CSPRClickSDK not requested."
   Then connect a real wallet and confirm the header chip loses its `demo` badge.
7. Verify the no-extension route too, since it is the one most visitors hit: in a clean browser
   profile with no wallet extension, click **Connect wallet**. With
   `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` set (§4b) you must get the pairing dialog with
   a QR (scannable by Casper Wallet on a phone → "WalletConnect"), not a button that does nothing;
   without it you must get the install prompt — WalletConnect is deliberately not offered.
   With the SDK reporting nothing present at all you must get "Could not connect a wallet" and an
   install link — never silence.
8. If Connect opens a `casperwallet.io/download` tab, the SDK read the device as mobile. Check
   `typeof window.CasperWalletProvider` — `"function"` means the extension is there and the
   disarm above should have run; `"undefined"` means it genuinely is not injected in that browser
   (no extension, or a mobile browser that cannot host one), and the handoff is correct.

The id in force is the one for `NEXT_PUBLIC_DEFAULT_NETWORK`, which also decides the SDK's
`chainName` (`src/config/csprclick.ts`). One network's id is never used for the other: an id
minted for mainnet would boot the SDK against the wrong chain, which is worse than falling back to
the labelled demo account.

An app id is a **public identifier** — it is inlined into the browser bundle by design and is not a
secret. The CSPR.cloud API key (§2) is the opposite: server-only, never `NEXT_PUBLIC_`.

### 3c. Who actually signs a human bet

Two paths, chosen by whether the visitor has a wallet that can sign:

| | signs | funds the stake + gas | `self.env().caller()` |
|---|---|---|---|
| `POST /api/chain/bet` | operator (`CASPER_BETTOR_KEY`) | operator | the operator |
| `POST /api/chain/bet/prepare` → wallet → `/confirm` | the visitor | the visitor | the visitor |

The second is the real one, and it is what a connected Casper Wallet gets. The server builds the
*same* Odra proxy-session transaction `placeBet` builds — same plan, same envelope, same gas — but
with the visitor's public key as initiator, and hands it back **unsigned**. Their wallet signs and
submits it via `csprclick.send()`; `/confirm` then waits for execution and indexes it.

The panel states which path ran ("you sign and fund this bet from your own account" vs "escrowed by
the operator on your behalf"), because the difference decides who can `claim`.

**Why `/confirm` needs a ticket.** Its naive form — "here is a hash and here is what it was worth" —
is a free-money endpoint for the read model: post any executed transaction's hash with a 10,000 CSPR
stake attached and the boards would show a bet nobody made. Confirming the hash executed does not
help; *some* transaction executed. So `prepare` mints an HMAC over exactly what it built (including
the transaction hash, which is known before signing because approvals are appended to the payload,
not part of it), and `/confirm` reads the bet's terms only from that ticket. See `lib/bet-ticket.ts`.

`BET_TICKET_SECRET` is the variable to set. Nothing breaks if you do not: it falls back to
`CRON_SECRET`, then `CASPER_BETTOR_KEY`, both server-only and both already present in real mode. With
none of them the prepare route returns 500 rather than mint a ticket anyone could forge.

Fallback is deliberate and narrow. A deployment that cannot offer wallet signing at all — the
simulated chain, or a demo account with no key — answers **501** on `prepare`, and the panel quietly
uses the operator-signed route. A **declined signature is never retried** that way: falling back
there would place a bet the visitor had just refused, with someone else's money.

With no app id set, no third-party script is served to anyone.

---

### 3a. Recurring rounds

A market with a non-`one-shot` `cadence` opens a fresh round as its previous one matures. The
tick's rollover step (`src/agent/round-rollover.ts`) opens the round the clock is currently in;
each round is a distinct vault entry addressed `<slug>#<roundIndex>`, so round N's stakes can
never leak into round N+1's payout.

**Current assignment, and why:**

| Market | Cadence | Rounds/day |
|---|---|---|
| `cspr-hourly-updown` ("CSPR up or down today?") | `daily` | 1 |
| `coin-flip-5m` ("The Flip") | `daily` | 1 |
| everything else | `one-shot` | 0 |

Both slugs are historical — they are the on-chain market ids and the keys in
`NEXT_PUBLIC_*_MARKET_ADDRS`, so renaming them would strand the routing. The **titles** were
corrected instead, because a market whose name outruns its cadence is the exact defect that kept
the economy from ever settling anything.

**The cadence is a budget decision, not a taste one.** At the measured 3.74 CSPR per
`create_market` and 6.317 consumed per resolve, one round costs ~11.5 CSPR all-in:

| Cadence | Rounds/day | Cost/day | Runway on a 1550 CSPR treasury |
|---|---|---|---|
| `5-minute` | 288 | ~3,310 CSPR | under a day |
| `hourly` | 24 | ~276 CSPR | ~5 days |
| `daily` (both markets) | 2 | ~23 CSPR | **~67 days (9.6 weeks)** |

`daily` is the fastest cadence that holds an 8-week runway floor. To change it, edit the
definition's `cadence` in `src/core/catalogue.ts`, recompute with `dailyRolloverCostMotes` +
`runwayDays` (`src/core/cadence.ts`), and update the title if the new cadence contradicts it —
a test pins that correspondence.

**Rollover never backfills.** It opens the current round only. A serverless economy misses ticks,
and paying 3.74 CSPR each to open rounds nobody could have bet on would burn the treasury for
markets with no possible participants.

**Rollover never touches a quarantined market.** Rolling one would silently resurrect what an
operator deliberately switched off, and bill the treasury to do it. Release it first (§8).

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

### The paid-but-not-placed breaker

An agent bet is two transactions — the agent pays the treasury over x402, then the operator escrows
the stake — and there is **no refund path between them**. If the escrow fails after the payment
lands, the agent bought nothing and the stake is gone. Per tick that loss is small and bounded; on
a 10-minute cron it is not.

So the tick counts CONSECUTIVE paid-but-not-placed failures and halts betting at three
(`src/agent/bet-breaker.ts`). The counter rides the KV envelope, because a counter that reset on
every cold start would never reach a threshold on serverless. Resolution is never gated by it —
that pays users what they are owed.

When it trips, `/api/health` fails the `bets` check (so a monitor pages someone) and names the last
failure's settlement hash to reconcile against. Nothing clears it but a bet that lands, or an
operator who has fixed the cause:

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" -H 'content-type: application/json' \
  -d '{"resetBreaker":true}' https://casper.playhunch.xyz/api/agent/tick
```

That request resets and ticks in one call, so you find out immediately whether the fix worked.

### Quarantined markets

The breaker above answers "the money path is broken everywhere". A narrower fault is more
expensive: one market whose catalogue entry disagrees with the contract it routes to reverts every
bet, forever. The fleet picks its target by `seq % openMarkets.length`, so that market comes back
on a fixed cycle and costs a full stake each time — and the breaker never trips, because the
failures are never consecutive.

So a placement that reverts with `UnknownOutcome` (3) or `UnknownMarket` (12) quarantines the slug:
those two mean config, not weather. Transport failures, timeouts and `MarketClosed` never do — a
blip must not silently shrink the catalogue. Quarantine rides the KV envelope, so a new instance
does not re-discover the fault by paying for it again.

`/api/health` warns on the `markets` check and names each quarantined slug. Fix the routing
(`NEXT_PUBLIC_*_MARKET_ADDRS` / the vault registration), then release:

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" -H 'content-type: application/json' \
  -d '{"releaseMarkets":["coin-flip-5m"]}' https://casper.playhunch.xyz/api/agent/tick
```

`{"releaseMarkets": true}` releases all of them.

The shipped case of exactly this fault — `coin-flip-5m`, quarantined 2026-07-19, repaired
2026-07-20: its `NEXT_PUBLIC_TESTNET_MARKET_ADDRS` entry pointed at the **bootstrap sample
market** (`contracts_cli deploy`, bin/cli.rs), whose outcome keys are uppercase
`HEADS`/`TAILS`/`TIE` while the catalogue bets lowercase `heads`/`tails`/`tie` — so every bet
reverted `UnknownOutcome`, and `catalogue-v2` had refused to create a vault twin because the
factory registry already had the id. The repair: `contracts_catalogue create-v2 <manifest>
coin-flip-5m 100` (force-creates the market inside vault v2 with the catalogue keys; the seed
bets double as on-chain proof the keys are accepted), then drop the slug from
`NEXT_PUBLIC_TESTNET_MARKET_ADDRS` so routing falls through to the vault, redeploy, release.
`contracts_catalogue market-info <package-hash>` prints what a deployed v1 package will
actually accept when you need to diagnose the next one.

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
hydrated before the first read and re-read at most every 30s (`HYDRATE_TTL_MS`), snapshotted after
every mutation (debounced, coalesced). The chain remains the source of truth for money; this is
durability for the *presentation* layer.

Hydration is **TTL-bounded, not once-per-instance**. The old latch pinned a warm reader to whatever
it saw on first load forever — on 2026-07-20, 3 of 25 concurrent `/api/agent/activity` responses
served 9 stale actions while KV and every cold instance held 12. Reads inside the 30s window stay
pure in-memory (no per-request round trip); the first read after it re-reads KV. The TTL **yields to
an in-flight write**: a re-read replaces memory wholesale, so letting one land on top of an unflushed
mutation would publish a merge that never saw it. Staleness self-heals on the next read; a dropped
write does not. `rehydrateEconomyState()` forces a read now, ignoring the TTL — the tick uses it so
it bets and resolves against the current economy.

Writes are **merge-on-persist** under optimistic concurrency, not last-writer-wins (which
truncated the production history on 2026-07-20 when a warm instance flushed its stale view —
round counter 42 → 5). Each flush GETs the stored envelope, merges it into memory, and
compare-and-sets the union against the revision it read (Lua `EVAL`, bounded retries on
conflict). Merge identities: activity by `ts+agent+market+kind` with the round counter taken as
`max` of both sides; created markets by slug; settlement by market id with settled beating
unsettled; oracle resolutions by `(oracle, market)` id; breaker and quarantine by newest
timestamp — a breaker clear stamps `clearedAt`, and a quarantine release leaves a
`[slug, releasedAt]` tombstone so a stale writer cannot resurrect what an operator released.

Failure behaviour is deliberate: a 3-second timeout, one warning, then the app continues on
in-memory state. Every concurrency guard **fails open to a plain SET** — a KV without `EVAL`, a
read outage, or exhausted CAS retries degrade to the old last-writer-wins write, never to a lost
flush. **KV downtime degrades durability, never availability.**

- Verify: `curl -s .../api/health | jq '.checks[] | select(.name=="persistence")'` — the detail
  carries the stored envelope's revision (`KV reachable in 41ms — envelope rev 128`). That number
  is the only outside proof CAS is landing: it must climb by at least one per flush. **If ticks keep
  landing while `rev` sits still, persistence has fallen open to last-writer-wins** — check whether
  the KV provider still supports `EVAL`. `no rev yet` means an empty key or an envelope written
  before merge-on-persist; it heals on the next flush.
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
