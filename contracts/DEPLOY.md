# Deploying the Hunch-on-Casper contracts

Two Odra (Rust) contracts make up the on-chain layer:

| Contract | Role |
|---|---|
| `MarketFactory` (`src/market_factory.rs`) | On-chain **registry** of markets (id → question / category / market address / deadline / resolved). Admin-gated writes, an event per registration. This is the economy's on-chain index — what MCP `list_markets` and the off-chain adapter read. |
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
ODRA_CASPER_LIVENET_NODE_ADDRESS=https://rpc.testnet.casperlabs.io/rpc
ODRA_CASPER_LIVENET_CHAIN_NAME=casper-test
ODRA_CASPER_LIVENET_SECRET_KEY_PATH=./keys/secret_key.pem
```

Then run the CLI driver (`bin/cli.rs`) — it deploys `MarketFactory`, deploys a sample
`ParimutuelMarket` (the 5-minute coin flip), and registers the market: **three real
transactions**.

```bash
cargo run --bin contracts_cli -- --help      # discover commands
cargo run --bin contracts_cli -- deploy      # deploy + register (livenet from .env)
```

Each call prints a deploy hash → view at `https://testnet.cspr.live/deploy/<hash>`.

## 5. Wire the addresses into the Next.js app

Put the deployed package/contract hashes into the app env (Vercel + `.env.local`) — the
network config already reads them (`src/config/network.ts`):

```bash
NEXT_PUBLIC_TESTNET_MARKET_FACTORY=hash-<factory>
NEXT_PUBLIC_TESTNET_VAULT=hash-<sample-market>
# mainnet equivalents: NEXT_PUBLIC_MAINNET_MARKET_FACTORY / _VAULT
```

The real `CasperChainPort` adapter (S2) reads these to place bets + resolve end-to-end.

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
