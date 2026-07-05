# Deploying the Hunch-on-Casper contracts

Three Odra (Rust) contracts make up the on-chain layer:

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
cargo odra test          # OdraVM backend — 15 unit/property tests, credential-free
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
