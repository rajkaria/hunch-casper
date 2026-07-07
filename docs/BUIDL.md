# BUIDL page content — Hunch on Casper

Paste-ready content for the DoraHacks BUIDL page, structured to satisfy the Casper Agentic
Buildathon final-round requirement:

> _Contract package hashes and sample Testnet transactions with descriptions on your BUIDL page._

Everything below is real and verifiable on the Casper **testnet** explorer, [cspr.live](https://testnet.cspr.live).

---

## Links

- **Live app:** <https://casper.playhunch.xyz>
- **Swarm dashboard (run the loop):** <https://casper.playhunch.xyz/agents>
- **Docs (API, MCP, x402, contracts):** <https://casper.playhunch.xyz/docs>
- **Testing playbook:** <https://github.com/rajkaria/hunch-casper/blob/main/docs/PLAYBOOK.md>
- **GitHub:** <https://github.com/rajkaria/hunch-casper>
- **Vision / roadmap:** <https://github.com/rajkaria/hunch-casper/blob/main/VISION.md>

---

## Deployed contract packages (Casper testnet)

Three original Odra/Rust contracts. Click any hash to open the contract package on cspr.live.

| Contract | Role | Package hash | Explorer |
|---|---|---|---|
| **MarketFactory** | On-chain registry of every deployed market. | `7f63a93187d4aa3ae7629ce1b15fcf49197d86cda7985ebfcb8a8a494f43d777` | [contract-package](https://testnet.cspr.live/contract-package/7f63a93187d4aa3ae7629ce1b15fcf49197d86cda7985ebfcb8a8a494f43d777) |
| **OracleRegistry** | Staked-reputation oracle registry; the Arbiter's accuracy is counted here, once per market. | `269834fd371596eacd0ff72c29cc45a4c175601185f33b7583a157bcf80c6282` | [contract-package](https://testnet.cspr.live/contract-package/269834fd371596eacd0ff72c29cc45a4c175601185f33b7583a157bcf80c6282) |
| **ParimutuelMarket** (vault) | Payable escrow + pull-style `claim()` with pure pool math — the money path. | `c6a1afd3208ffe878802d8df71665c4b70b4365b70c5e6d87dec646090964529` | [contract-package](https://testnet.cspr.live/contract-package/c6a1afd3208ffe878802d8df71665c4b70b4365b70c5e6d87dec646090964529) |

---

## Sample testnet transactions

Each row is a real, successful transaction that bootstrapped the on-chain economy.

| # | Transaction | What it does | Explorer |
|---|---|---|---|
| 1 | Deploy `OracleRegistry` | Installs the staked-oracle registry contract on testnet. | [b85537…60298](https://testnet.cspr.live/transaction/b85537a2c5926c4687e87510b345ce5bb9a4153d20f79687d5c830bdc3d60298) |
| 2 | `register_oracle` | Registers the Arbiter agent as the on-chain oracle whose reputation is staked on its accuracy. | [c26957…06843](https://testnet.cspr.live/transaction/c26957021830fa491b4fcab31bf20736bcefff4fec1fd762cb34059977206843) |
| 3 | Deploy `ParimutuelMarket` | Installs a parimutuel market vault (payable escrow + deterministic `claim()`). | [2b0cbe…d1d677](https://testnet.cspr.live/transaction/2b0cbe25f382b40828b34d9c889fea3f1ac03cddbca32fe0dc4e0b6256d1d677) |
| 4 | `register_market` | Registers the deployed vault in the MarketFactory — wiring the economy's on-chain foundation. | [d179b6…cc84aa](https://testnet.cspr.live/transaction/d179b690b768a807466f9864f7fbb617de5a4a5fc01aa0161ebe67176ecc84aa) |

> **More receipts render live in the app.** When the deployment env vars are wired
> (`NEXT_PUBLIC_TESTNET_MARKET_*`, `NEXT_PUBLIC_ONCHAIN_RECEIPTS`), the **Live on Casper** section on
> the landing page and `/docs#onchain` renders the full set — the five flagship catalogue-market
> packages (`cspr-price-05-aug`, `cspr-hourly-updown`, `btc-150k-aug`, `prophet-race-weekly`,
> `arbiter-accuracy-95`) plus the full money-path receipt chain (install → 120 CSPR bet YES → 80
> CSPR bet NO → oracle resolve → 198.4 CSPR claim). To enumerate those on this BUIDL page, copy the
> `label`/`hash` pairs from the deployment's `NEXT_PUBLIC_ONCHAIN_RECEIPTS` value.

---

## How to test (for judges)

The full step-by-step is in the
[**testing playbook**](https://github.com/rajkaria/hunch-casper/blob/main/docs/PLAYBOOK.md). The
2-minute version:

1. Open <https://casper.playhunch.xyz/agents> → **Run the whole loop**. Watch Genesis open a market,
   the Prophets bet via x402, and the Arbiter resolve.
2. Open any market → place a bet. Pool-implied odds move; the payout preview is pure parimutuel math.
3. Open any contract package or transaction link above on cspr.live to confirm it is real.
4. Connect your own agent:
   `claude mcp add --transport http hunch-casper https://casper.playhunch.xyz/api/mcp`

> The public demo runs in mock chain mode by design (deterministic, always alive, credential-free);
> on-chain reality is proven by the hashes above. Simulated hashes in the app's feed are labelled
> `simulated` and never link to the explorer.

---

## Community

- Casper Developers (Telegram): <https://t.me/CSPRDevelopers>
- Casper Network (Discord): <https://discord.com/invite/caspernetwork>
