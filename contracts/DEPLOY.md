# Deploying the Hunch-on-Casper contracts

The on-chain layer began as three Odra (Rust) contracts and has grown to nine as the roadmap
shipped. The three below are the core money path documented in detail here; the S16–S29 additions —
`HunchVault` (singleton vault), `AgentRegistry` (bonded identity), `DisputePanel` (optimistic
resolution), `ResolutionHook` (oracle-as-a-service), `LmsrMarket` (continuous liquidity), and
`CopyBetting` (mirrored-fee split) — are covered in [`contracts/AUDIT.md`](AUDIT.md).

| Contract | Role |
|---|---|
| `MarketFactory` (`src/market_factory.rs`) | On-chain **registry** of markets (id → question / category / market address / deadline / resolved). Admin-gated writes, an event per registration. This is the economy's on-chain index — what MCP `list_markets` and the off-chain adapter read. |
| `OracleRegistry` (`src/oracle_registry.rs`) | Oracle **identity + staked reputation** (accuracy in basis points). Admin-gated `register_oracle` / `record_resolution`, at most once per (oracle, market). The Arbiter's on-chain identity; the off-chain reputation ledger mirrors it. |
| `ParimutuelMarket` (`src/parimutuel_market.rs`) | The payable **escrow + settlement vault** for a single market. Bettors escrow native CSPR onto an outcome; the oracle resolves/voids; winners `claim` a pro-rata share by **pure pool math** (never an LLM). Parimutuel fee taken only from the losing pool. Degenerate rounds (single participant, no winner, void) refund in full with no fee. |

> **Why a registry, not an on-chain child-deploying factory?** Odra's `factory=on` feature
> can't run on the OdraVM test backend (its own examples `#[ignore]` those tests), so it
> can't be covered by the green gate. A registry + separately-deployed markets is fully
> testable, cheaper, and maps 1:1 to `CasperChainPort`. Genesis deploys a `ParimutuelMarket`,
> then registers it.

## 0. Prerequisites (one-time)

```bash
rustup toolchain install nightly-2026-01-01      # pinned in contracts/rust-toolchain
rustup target add wasm32-unknown-unknown
cargo install cargo-odra --locked
# casper-client is optional — the odra-cli deploy path below does not need it
```

## 1. Test (no credentials, runs in CI)

```bash
cd contracts
cargo odra test          # OdraVM backend — 95 unit/property tests, credential-free
```

## 2. Build the Casper wasm

```bash
cargo odra build          # cargo-odra 0.1.7 builds the Casper wasm by default
# → contracts/wasm/MarketFactory.wasm, contracts/wasm/ParimutuelMarket.wasm
```

## 3. Get a funded testnet key  ⚠️ human step (faucet is browser/captcha-gated)

```bash
# generate an ed25519 keypair
casper-client keygen ./keys           # writes secret_key.pem + public_key_hex
```

Fund `public_key_hex` at the **testnet faucet**: <https://testnet.cspr.live/tools/faucet>
(Sign in, paste the public key, request CSPR). Mainnet: fund the account with real CSPR
and keep the per-bet cap + unaudited banner on (see `src/config/network.ts` guardrails).

## 4. Deploy (produces the real on-chain transactions)

Create `contracts/.env` (see `.env.example`):

```bash
ODRA_CASPER_LIVENET_NODE_ADDRESS=https://node.testnet.casper.network/rpc
ODRA_CASPER_LIVENET_EVENTS_URL=https://node.testnet.casper.network/events
ODRA_CASPER_LIVENET_CHAIN_NAME=casper-test
ODRA_CASPER_LIVENET_SECRET_KEY_PATH=./keys/secret_key.pem
```

Then run the CLI driver (`bin/cli.rs`) — it deploys `MarketFactory` + `OracleRegistry`
(registering the deployer as the "Arbiter" oracle) + a sample `ParimutuelMarket` (the
5-minute coin flip), and registers the market: **real on-chain transactions**.

```bash
cargo run --bin contracts_cli -- --help      # discover commands
cargo run --bin contracts_cli -- deploy      # deploy + register (livenet from .env)
```

Each transaction prints a hash → view at `https://testnet.cspr.live/transaction/<hash>`
(Casper 2.0 / Condor serves `TransactionV1` under `/transaction/`, not the legacy `/deploy/`).

### 4b. Deploy the full catalogue + mint receipts (`contracts_catalogue`)

`bin/catalogue.rs` finishes what `deploy` bootstraps — it reads the app's deploy-plan manifest
and pushes the whole catalogue on-chain, then mints the receipt transactions the site links to:

```bash
curl -s "https://casper.playhunch.xyz/api/deploy-plan?network=testnet" > /tmp/deploy-plan.json

cargo run --bin contracts_catalogue -- balance      # free config + funds sanity check

# Full money path on a dedicated receipts market: deploy → bet yes → bet no →
# resolve (fee sweep) → claim. Five real transactions; paste the hashes into
# NEXT_PUBLIC_ONCHAIN_RECEIPTS.
cargo run --bin contracts_catalogue -- lifecycle

# One ParimutuelMarket per catalogue market, registered into the factory, seeded with
# ratio-preserving house bets (manifest seedBets ÷ divisor; 0 = skip seeding).
# `all` or a csv of slugs; `coin-flip-5m` deploys but skips registration (the bootstrap
# already registered that id → re-registering reverts with DuplicateId).
HUNCH_FACTORY=hash-<factory> \
  cargo run --bin contracts_catalogue -- catalogue /tmp/deploy-plan.json all 100
```

Machine-readable `HUNCH_MARKET slug=<slug> package=<hash>` lines make up the
`NEXT_PUBLIC_*_MARKET_ADDRS` map; each Odra log line prints the tx hash + explorer link. The
driver aborts before any market install that would run the deployer below ~650 CSPR.

### 4c. S16 — singleton HunchVault v2 (markets for ~4 CSPR, no more installs)

v1 installed one `ParimutuelMarket` per market (measured net **324.27 CSPR** each — tx
`2b0cbe…`, limit 400, consumed 299.023, 75% refund on the unused 100.977). v2 installs **one**
`HunchVault` and every market after that is a cheap `create_market` entrypoint call —
measured **3.74 CSPR** net per market (2.32 consumed at the 8-CSPR limit; the payable
proxy keeps it above the sub-CSPR registry writes), ~87x cheaper than a v1 install. The
driver prints the measured cost per call (`HUNCH_GAS` line). Already-deployed v1 markets
stay routable untouched (the app's per-market map wins over the vault,
`src/adapters/casper/deploy-plan.ts`).

> **Deploying against a pre-S16 factory?** A `MarketFactory` installed before S16 has no
> `set_vault`/`register_vault_market` entrypoints — and Odra's plain `deploy()` installs
> **locked** packages, so it can never grow them. The driver handles this: `vault-deploy`
> treats a failed `set_vault` as a note, and `catalogue-v2` registers vault markets through
> the v1 `register_market` with the vault as the explicit market address. Same registry
> semantics either way (`register_vault_market` is sugar that fills in the vault address).

```bash
# 1. One-time: install the vault singleton (~ the old cost of ONE market) and point
#    the MarketFactory registry at it. <bond-motes> is the creation bond every
#    create_market must attach (refunded to the creator at settlement); 0 disables.
HUNCH_FACTORY=hash-<factory> \
  cargo run --bin contracts_catalogue -- vault-deploy 1000000000
# → HUNCH_VAULT_V2 package=hash-<vault-v2>

# 2. Create + register (+ seed) the remaining catalogue INSIDE the vault. Slugs already
#    in the vault or registry are skipped, so the command is safely re-runnable.
HUNCH_FACTORY=hash-<factory> HUNCH_VAULT_V2=hash-<vault-v2> \
  cargo run --bin contracts_catalogue -- catalogue-v2 /tmp/deploy-plan.json all 100

# 3. Receipts on the singleton: create → bet yes → bet no → resolve (fee sweep) → claim,
#    all five transactions against the ONE vault contract (slug receipts-vault-v2).
HUNCH_VAULT_V2=hash-<vault-v2> \
  cargo run --bin contracts_catalogue -- lifecycle-v2
```

### 4d. FieldMarket — the wide-field market (177 buildathon finalists)

One market on the board does **not** live in the vault: `casper-buildathon-2026-winner`, whose
field is the 177 Casper Agentic Buildathon finalists. `HunchVault` caps a market at 8 outcomes
(`MAX_OUTCOMES`) because it scans the outcome list on every bet, so a 177-candidate market there
would be rejected at creation — and if the routing ever *did* fall through to the vault, the app
throws instead of submitting the stake (`resolveMarketTarget`, rule 0).

`FieldMarket` keeps the candidate set in a dictionary (`Mapping<String, bool>`), so membership is
one read regardless of field width, and exposes the same money-path ABI as `ParimutuelMarket`
(`bet(outcome)` / `resolve(winning_outcome)` / `claim`) — which is why the app needs no new bet
path for it. The deploy is three separately retryable steps:

```bash
# 0. The manifest carries the field: candidate keys, the count, and the sha256 commitment
#    over the ordered list (markets[].field). Same file as the catalogue deploys.
curl -s 'https://casper.playhunch.xyz/api/deploy-plan?network=testnet' > /tmp/deploy-plan.json

# 1. Install. Registers NO candidates — 177 keys do not fit in one transaction — and refuses
#    to start unless the deployer can also afford every registration batch plus the freeze.
cargo run --bin contracts_catalogue -- \
  field-deploy /tmp/deploy-plan.json casper-buildathon-2026-winner
# → HUNCH_FIELD_MARKET hash-<field-market>

# 2. Fill the field, 40 keys per batch, skipping anything already on chain. Safe to re-run:
#    re-registering an existing key is a no-op on chain, so a lost receipt costs gas, not a
#    broken deploy.
cargo run --bin contracts_catalogue -- \
  field-register hash-<field-market> /tmp/deploy-plan.json casper-buildathon-2026-winner

# 3. Seal it. Betting is CLOSED until this lands (`FieldNotFrozen`) and no candidate can be
#    added or removed after it. Verifies every manifest key is on chain and that the count
#    matches before it will freeze, then records the commitment.
cargo run --bin contracts_catalogue -- \
  field-freeze hash-<field-market> /tmp/deploy-plan.json casper-buildathon-2026-winner

# Anytime: where the deploy got to, and what the app should be showing.
cargo run --bin contracts_catalogue -- field-info hash-<field-market>
```

Wire it into the app with **`NEXT_PUBLIC_TESTNET_FIELD_MARKET=hash-<field-market>`** (§5). Until
that is set, `/buildathon` says the market is not live rather than offering a bet that cannot be
placed.

Settlement, once the organizers publish results — the winner is a BUIDL id, and the evidence hash
is committed in the same command because a resolution whose justification never gets published is
the thing the evidence bundle exists to prevent:

```bash
cargo run --bin contracts_catalogue -- \
  field-resolve hash-<field-market> 46696 <sha256-of-the-announcement>
```

`resolve` is deliberately **not** deadline-gated: results are announced when they are announced,
and resolving early closes betting the instant the outcome is public. If the announcement names
co-winners with no single first place, void instead (every stake refunds in full).

**Measured on the 2026-08-01 testnet run** (net = consumed + 25% of the unused limit). The live
testnet FieldMarket is `hash-dd4c2a59183c251a9654ea79130916ff6ae9c06b7159910745f12c2b79a7930e`,
holding the 177-finalist field frozen at commitment `59f84e52a4a6271220dee52c2353a9435e584fedec049353cf533d1b79b81e7b`:

| call | measured cost (CSPR) | tx |
|---|---|---|
| `FieldMarket` install (331,421-byte wasm, limit 450) | 354.10 net | `4f802fa1…` |
| `register_candidates` × 40 keys (limit 10) | 7.458 net | `be19ce69…`, `e7d49510…`, `96966f9d…`, `4bc237d2…` |
| `register_candidates` × 17 keys (limit 10) | 4.734 net | `42abda06…` |
| `freeze_field` (limit 10) | 2.942 net | `9d476f58…` |
| **whole deploy, install → open for betting** | **391.61** | — |

Registration is ~0.186 CSPR per candidate and flat in the field width, which is the dictionary
paying off: the same 177 outcomes in a `Vec`-backed market would be re-serialised on every read.

**Budget.** Sized from the measured v1 install (299.023 consumed at a 400 limit): the install
limit is 450 CSPR and must be affordable *up front* — testnet holds the full limit at acceptance
and refunds 75% of the unused part. Five registration batches plus the freeze are budgeted at 10
CSPR of limit each. Have **≈ 500 CSPR** in the deployer before starting; the faucet
(https://testnet.cspr.live/tools/faucet, human-only) covers it in one request. `field-deploy`
aborts with `HUNCH_ABORT low-balance` rather than stranding a contract with an unfreezable field.

Two repair/diagnosis commands round out the v2 set. `market-info` is a free read of a deployed
v1 `ParimutuelMarket` — question, status, outcome keys, pools — i.e. what the package will
*actually* accept, independent of what the env map claims. `create-v2` force-creates ONE
manifest market inside the vault even when the factory registry already has its id —
`catalogue-v2` refuses that case, which is correct for a healthy v1 contract and wrong when the
registered contract is bad (the shipped case: `coin-flip-5m`'s registry entry is the bootstrap
sample market keyed `HEADS`/`TAILS`/`TIE`, so catalogue bets on `heads`/`tails`/`tie` always
reverted `UnknownOutcome`; see docs/OPS.md "Quarantined markets"):

```bash
cargo run --bin contracts_catalogue -- market-info hash-<package>
HUNCH_FACTORY=hash-<factory> HUNCH_VAULT_V2=hash-<vault-v2> \
  cargo run --bin contracts_catalogue -- create-v2 /tmp/deploy-plan.json coin-flip-5m 100

# Free reads of the vault's creation policy (+ whether an account is an approved oracle),
# and the operator's manual-resolution backstop (signer must be the market's config.oracle —
# the deployer for every catalogue market). The app's Arbiter reconciles its mirror to a
# manually-resolved market on its next sweep (AlreadySettled → settle off-chain, no retry).
HUNCH_VAULT_V2=hash-<vault-v2> cargo run --bin contracts_catalogue -- vault-info [account-hash-…]
HUNCH_VAULT_V2=hash-<vault-v2> cargo run --bin contracts_catalogue -- resolve-v2 <slug> <outcome>
```

Wire the vault into the app with `NEXT_PUBLIC_TESTNET_VAULT_V2=hash-<vault-v2>` (§5):
slugs absent from `NEXT_PUBLIC_TESTNET_MARKET_ADDRS` then route to the vault carrying the
slug as the `market_id` runtime arg — `bet(market_id, outcome)` / `resolve(market_id,
winning_outcome)`. Measured on the 2026-07-18 testnet run (net = consumed + 25% of the
unused limit; the testnet vault is
`hash-ce45136047089a4d0882c7b52f1df6a01ff8e601c1b097440f705fdc9f2876a1`):

| call | measured cost (CSPR) | tx |
|---|---|---|
| `HunchVault` install (one-time) | 373.07 net (364.099 consumed, limit 400) | `43eab0e4…` |
| `create_market` (first — initializes the vault dictionaries) | 5.22 net (4.958 consumed, limit 6) | `40273e4b…` |
| `create_market` (typical) | 3.74 net (2.323 consumed, limit 8) | `e2bb364c…` |
| `register_market` | 1.48 net (0.976 consumed, limit 3) | `1515eff3…` |
| `bet` | 3.08 net (1.439 consumed, limit 8) | `79f232a6…` |
| `resolve` (fee sweep + bond refund) | 6.74 net (6.317 consumed, limit 8) | `46312a4c…` |
| `claim` | 4.19 net (2.921 consumed, limit 8) | `1364254c…` |

### 4e. S19 — open permissionless creation

`create_market` is admin-only until the vault's `open_creation` flag is flipped. Opening it
lets any address (human or agent) mint a market, so the vault enforces guardrails on
**non-admin creators only** — the admin keeps the full parameter range and the curated
catalogue is unaffected:

| guardrail | why |
|---|---|
| oracle must be admin-**approved** and **not the creator** | the oracle decides who gets paid; a self-appointed one takes the other side's stake and resolves in its own favour |
| fee ≤ 500 bps | the raw check only bars ≥ 100%, which still permits a 99% honeypot |
| deadline ≤ 180 days out | stakes are escrowed until settlement, so an unbounded deadline is an unbounded lockup |
| `meta` category reserved | meta-markets score the agent leaderboards — public minting would contaminate the self-scoring board (AGENTS.md) |
| ≤ 5 simultaneously-open markets per creator | bounds spam; the slot frees at settlement alongside the bond, so honest creators face no lifetime ceiling |

Field bounds (id ≤ 64, question ≤ 200, category ≤ 32, outcome key ≤ 32, ≤ 8 unique
outcomes) are input sanity and apply to **every** creator, admin included.

```bash
# 1. Approve the oracle(s) that may back public markets FIRST — the allowlist is not
#    enumerable on chain, so opening with an empty one makes every public create_market
#    revert OracleNotApproved.
HUNCH_VAULT_V2=hash-<vault-v2> \
  cargo run --bin contracts_catalogue -- approve-oracle account-hash-<arbiter> true

# 2. Then flip creation open (re-runnable; pass false to close it again).
HUNCH_VAULT_V2=hash-<vault-v2> \
  cargo run --bin contracts_catalogue -- open-creation true
```

Both are cheap registry-shaped calls (`REGISTRY_GAS`). Revoking an oracle later affects only
*future* creations — a market's oracle is bound at creation and immutable, so a revocation
can never strand an open market's resolution.

## 5. Wire the addresses into the Next.js app

Put the deployed package/contract hashes into the app env (Vercel + `.env.local`) — the
network config already reads them (`src/config/network.ts`):

```bash
NEXT_PUBLIC_TESTNET_MARKET_FACTORY=hash-<factory>
NEXT_PUBLIC_TESTNET_ORACLE_REGISTRY=hash-<oracle-registry>
NEXT_PUBLIC_TESTNET_VAULT=hash-<sample-market>
# mainnet equivalents in §6: NEXT_PUBLIC_MAINNET_MARKET_FACTORY / _ORACLE_REGISTRY / _VAULT
```

The real `CasperChainPort` adapter (S2) reads these to place bets + resolve end-to-end.

**Full-catalogue routing.** When you deploy one `ParimutuelMarket` per catalogue market (§6
step 3), give the app the slug → package-hash map so each bet/resolve targets the market's OWN
contract (unmapped slugs fall back to `_VAULT`):

```bash
# JSON object keyed by catalogue slug (slugs listed by /api/deploy-plan?network=testnet)
NEXT_PUBLIC_TESTNET_MARKET_ADDRS={"the-flip":"hash-<...>","cspr-above-5c-aug1":"hash-<...>"}
```

**Wide-field routing.** The buildathon market has its own contract and its own variable — it is
NOT an entry in the address map, because a missing entry there falls through to the vault and a
177-outcome market must never do that (§4d):

```bash
NEXT_PUBLIC_TESTNET_FIELD_MARKET=hash-<field-market>
```

**On-chain proof for judges.** Paste the deploy/bet/resolve tx hashes you just minted into
`NEXT_PUBLIC_ONCHAIN_RECEIPTS` (see `.env.example`) — the landing page + docs render them as a
"Live on Casper" section with real cspr.live links.

## 6. Mainnet — deploy the full catalogue (S11)

Same code, same contracts, second network. The app's Testnet ⇄ Mainnet toggle already routes
every read + the money path through `src/config/network.ts`; mainnet only needs its contracts
deployed and its addresses wired. **Mainnet keeps its guardrails on**: a per-bet cap
(`guardrails.maxBetCspr`, 25 CSPR) enforced in the human bet route, the agent x402 rail, and the
trade panel, plus a persistent "unaudited hackathon build" disclosure banner. Fresh, unaudited
Rust holds real value here — the cap + banner are the safety envelope, never removed.

1. **Fund a mainnet key with real CSPR.** No faucet — acquire CSPR and fund the deployer account.
   Point `contracts/.env` at mainnet:

   ```bash
   ODRA_CASPER_LIVENET_NODE_ADDRESS=https://node.mainnet.casper.network/rpc
   ODRA_CASPER_LIVENET_EVENTS_URL=https://node.mainnet.casper.network/events
   ODRA_CASPER_LIVENET_CHAIN_NAME=casper
   ODRA_CASPER_LIVENET_SECRET_KEY_PATH=./keys/mainnet_secret_key.pem
   ```

2. **Bootstrap the singletons + a first market.** `cargo run --bin contracts_cli -- deploy`
   deploys `MarketFactory` + `OracleRegistry` (+ registers the Arbiter) + the sample market —
   the network's on-chain foundation.

3. **Deploy the whole catalogue from the manifest.** The catalogue is the single source of truth
   for what belongs on-chain; the app serves the exact per-market deploy args at

   ```bash
   curl -s https://casper.playhunch.xyz/api/deploy-plan?network=mainnet | jq
   ```

   Each entry in `markets[]` carries the `ParimutuelMarket.init` args (`question`, `feeBps`,
   `deadlineMs`, `outcomeKeys`), the `MarketFactory.register_market` args, and the house
   `seedBets` (outcome → motes) to escrow so on-chain pools mirror the catalogue seed. Deploy +
   register each market with those values (a scripted loop over the CLI, or extend
   `HunchDeployScript`). `infrastructure[]` names the two singletons; `guardrails` echoes the
   mainnet cap + banner so an operator can't miswire them.

4. **Wire the addresses** (Vercel project `hunch-casper` env + `.env.local`):

   ```bash
   NEXT_PUBLIC_MAINNET_MARKET_FACTORY=hash-<factory>
   NEXT_PUBLIC_MAINNET_ORACLE_REGISTRY=hash-<oracle-registry>
   NEXT_PUBLIC_MAINNET_VAULT=hash-<a-deployed-market-package>
   # per-market routing for the full catalogue (slug → package hash, JSON — see §5)
   NEXT_PUBLIC_MAINNET_MARKET_ADDRS={"the-flip":"hash-<...>", ...}
   # optional: default the site to mainnet (the toggle still flips to testnet)
   # NEXT_PUBLIC_DEFAULT_NETWORK=mainnet
   ```

   Flip the real chain adapter on with `CASPER_CHAIN_MODE=real` + the funded `CASPER_BETTOR_KEY`
   / oracle key (see §4). Redeploy. The header toggle now flips both networks live — testnet's
   free-CSPR economy and mainnet's capped, disclosed one — off the same build.

## Payout math (the money path — pure + deterministic)

For a resolved market with winning outcome `w`:

```
total    = Σ pools
winning  = pool[w]
losing   = total − winning
fee      = losing × fee_bps / 10_000              # swept to treasury on resolve()
payout_i = stake_i + stake_i × (losing − fee) / winning    # claimed pull-style
```

Edge cases (all refund full gross, **no fee**):
- `winning == 0` (nobody on the winning side) → auto-void, everyone refunds their stake.
- `losing == 0` (single participant / everyone on the winning side) → stake back.
- explicit `void()` (flat / undecidable round) → everyone refunds their stake.

Integer division dust (sub-mote) stays in the contract. Claims are idempotent per address.
