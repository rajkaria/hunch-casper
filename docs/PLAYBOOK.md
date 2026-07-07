# Testing playbook — Hunch on Casper

Step-by-step instructions to verify the MVP. No marketing — just what to click, run, and check.
Two paths: **A) the live testnet demo** (no install) and **B) run it locally**. Then verify the
on-chain contracts, connect an agent, and run the test suites.

Live app: <https://casper.playhunch.xyz> · Repo: <https://github.com/rajkaria/hunch-casper>

> The public demo runs in **mock chain mode** by design: the economy is deterministic, always
> alive, and credential-free. On-chain reality is proven separately by the deployed contracts and
> transaction receipts in [§4](#4-verify-the-contracts-and-transactions-on-chain). Mock-mode hashes
> in the activity feed are labelled `simulated` and never link to the explorer.

---

## 1. The whole loop in one click (30 seconds)

1. Open <https://casper.playhunch.xyz/agents>.
2. Click **Run the whole loop**.
3. Watch the sequence: **Genesis** opens a market → the four **Prophets** each place a bet via x402
   (each row narrates why) → the **Arbiter** resolves → the **PnL** and **accuracy** boards update.
4. Confirm the activity feed shows the new market, four bets, and one resolution.

**Expected:** boards change after the loop runs; every simulated tx row carries a `simulated` chip.

---

## 2. Place a bet and read the odds (1 minute)

1. Open <https://casper.playhunch.xyz/markets> and click any open market.
2. Note the pool-implied odds and the payout preview.
3. Enter a stake on YES or NO and place the bet.
4. Confirm: the pool updates, the odds shift toward the side you backed, and the payout preview
   recalculates. This is pure parimutuel math — no LLM is involved in the number.

**Expected:** odds and payout move deterministically with pool size; the fee only ever comes from
the losing pool.

---

## 3. Run it locally (3 minutes)

Requirements: Node.js 22+, [pnpm](https://pnpm.io/) 10+.

```bash
git clone https://github.com/rajkaria/hunch-casper.git
cd hunch-casper
pnpm install
pnpm dev            # http://localhost:3000
```

No secrets required — the default mock adapters are credential-free. Repeat §1 and §2 against
`http://localhost:3000`.

Drive the economy from the API instead of the UI:

```bash
# Run one full turn (Genesis → Prophets → Arbiter)
curl -s -X POST http://localhost:3000/api/agent/tick | jq

# List open markets on testnet
curl -s "http://localhost:3000/api/markets?network=testnet" | jq '.markets[].slug'

# Inspect a single market's odds
curl -s "http://localhost:3000/api/markets/<slug>?network=testnet" | jq
```

Individual roles: `POST /api/agent/genesis/run`, `/api/agent/prophets/run`, `/api/agent/arbiter/run`.
Boards: `GET /api/agent/leaderboard`, `/api/agent/activity`.

---

## 4. Verify the contracts and transactions on-chain

The three contracts are deployed and live on **Casper testnet**. Open each on cspr.live and confirm
it exists:

| Contract | cspr.live |
|---|---|
| `MarketFactory` | <https://testnet.cspr.live/contract-package/7f63a93187d4aa3ae7629ce1b15fcf49197d86cda7985ebfcb8a8a494f43d777> |
| `OracleRegistry` | <https://testnet.cspr.live/contract-package/269834fd371596eacd0ff72c29cc45a4c175601185f33b7583a157bcf80c6282> |
| `ParimutuelMarket` (vault) | <https://testnet.cspr.live/contract-package/c6a1afd3208ffe878802d8df71665c4b70b4365b70c5e6d87dec646090964529> |

Sample transactions (each opens on cspr.live as a real, successful deploy):

| Transaction | cspr.live |
|---|---|
| Deploy `OracleRegistry` | <https://testnet.cspr.live/transaction/b85537a2c5926c4687e87510b345ce5bb9a4153d20f79687d5c830bdc3d60298> |
| `register_oracle` (Arbiter registered as oracle) | <https://testnet.cspr.live/transaction/c26957021830fa491b4fcab31bf20736bcefff4fec1fd762cb34059977206843> |
| Deploy `ParimutuelMarket` vault | <https://testnet.cspr.live/transaction/2b0cbe25f382b40828b34d9c889fea3f1ac03cddbca32fe0dc4e0b6256d1d677> |
| `register_market` (vault registered in factory) | <https://testnet.cspr.live/transaction/d179b690b768a807466f9864f7fbb617de5a4a5fc01aa0161ebe67176ecc84aa> |

The same links render in the app's **Live on Casper** section (landing page and
`/docs#onchain`) whenever the deployment env vars are wired. See [`../contracts/DEPLOY.md`](../contracts/DEPLOY.md)
for the deploy runbook and [`BUIDL.md`](./BUIDL.md) for the full hash + transaction list.

**Expected:** each link resolves to a real contract package / successful transaction on the Casper
testnet explorer.

---

## 5. Connect your own agent over MCP (1 minute)

The Prophets use a public MCP surface. Join it from any MCP client:

```bash
claude mcp add --transport http hunch-casper https://casper.playhunch.xyz/api/mcp
```

Then ask your agent:

> list the open markets and quote a 5 CSPR bet on The Flip

Seven tools are exposed: `list`, `get`, `odds`, `quote`, `place_bet`, `reputation`, `leaderboard`.

**Expected:** the client lists the tools and returns live market data.

---

## 6. Exercise the x402 handshake directly (2 minutes)

For agents that speak HTTP instead of MCP, `POST /api/agent/v1/bet` implements the HTTP-402 flow.

```bash
# Step 1 — POST a bet with no payment header → HTTP 402 + payment requirements (amount, payTo, nonce)
curl -s -i -X POST https://casper.playhunch.xyz/api/agent/v1/bet \
  -H 'content-type: application/json' \
  -d '{"network":"testnet","slug":"the-flip","side":"YES","amountCspr":5}'
```

The response is `402 Payment Required` with the payment requirements and a payout preview. Pay the
CSPR, then retry with `X-PAYMENT: base64(json({ scheme, deployHash, nonce }))`. The proof is
single-use and payer-bound; on success you get an `X-PAYMENT-RESPONSE` header and the bet is
escrowed. In real mode (`CASPER_X402_PAYTO`) the proof is verified against an actual on-chain CSPR
transfer.

**Expected:** the first request returns 402 with a nonce; a replayed or mismatched proof is rejected.

---

## 7. Run the test suites (green gate)

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # TypeScript app gate (matches CI)
cd contracts && cargo odra test                          # Odra/Rust contract tests
```

**Expected:** the TS gate passes (501+ Vitest tests) and the contract suite passes (22 OdraVM
tests). CI runs both on every push.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Boards look empty on first load | Run the loop (§1) or `POST /api/agent/tick` — the cold-start seed populates through the real payout engine. |
| `pnpm dev` port in use | `PORT=3001 pnpm dev`. |
| "Live on Casper" section not visible | Expected on a deployment without the `NEXT_PUBLIC_*` deploy env vars — verify the contracts directly via §4 instead. |
| `cargo odra test` fails to build wasm | Install `wabt` + a current `binaryen` (see `.github/workflows/ci.yml` for the exact versions CI uses). |
| MCP client can't connect | Confirm the transport is `http` and the URL ends in `/api/mcp`. |
