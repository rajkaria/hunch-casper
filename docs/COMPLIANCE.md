# Compliance posture — Hunch on Casper

This document states, plainly, what this project will and will not host, and how those limits are
enforced in code rather than left to good intentions. It is a hackathon/testnet posture, written so
that a reviewer, an operator, or a future contributor knows the boundary and where it lives.

## 1. Nature of the deployment

- **Testnet-only, no real money.** The public surface runs against Casper **testnet**; the demo
  runs in deterministic mock chain mode. No mainnet deployment carries real funds without an
  independent audit (see [`contracts/AUDIT.md`](../contracts/AUDIT.md)).
- **Not a licensed exchange or a gambling operator.** This is a research/hackathon prediction-market
  demo. It is not offered as, and must not be operated as, a real-money betting service without the
  licensing that entails in the operator's jurisdiction. The mainnet build ships an unaudited-build
  banner and a per-bet cap as precautions, not as a substitute for that licensing.

## 2. Market-category policy (enforced in code)

Some markets are never allowed, regardless of who proposes them. The policy lives in
[`src/core/category-policy.ts`](../src/core/category-policy.ts) as a pure, tested filter, and it is
applied at **every** creation surface:

- **Genesis** (the autonomous market-maker) runs `assessMarketFields` before a market can be
  registered — a rejected question throws, so the agent cannot create it.
- **Human market creation** (S23 NL composer) runs the same filter on the composed question before
  a bond is posted.

Prohibited categories and their reason codes:

| Reason code | Rejected |
|---|---|
| `violence-or-death` | Assassination, murder, mass-casualty, terror-attack markets |
| `harm-to-person` | Predicting a named/identifiable person's death or health |
| `illegal-activity` | Markets on clearly illegal acts (trafficking, contract killing, hard-drug sale) |
| `manipulation-prone` | Outcomes that invite manipulation — rug-pulls, pump-and-dumps, insider events |
| `hateful-or-abusive` | Targeted hateful or abusive framing |

The filter matches on **word boundaries and phrases**, not substrings, so legitimate markets
("deadline", "sudden-death overtime", "war-chest proposal", "up or down") are not caught. The full
shipped catalogue is asserted to pass the filter in `test/category-policy.test.ts`, and each
prohibited category has a rejection test.

This list is deliberately conservative and code-enforced rather than exhaustive: it is the floor,
not the ceiling. An operator running a real deployment in a specific jurisdiction is responsible for
tightening it to local law — the filter is the seam to do that in one place.

## 3. Geographic / jurisdictional posture

- No geo-gating is implemented in the demo (testnet, no real money). A real-money operator is
  responsible for jurisdiction-based access controls appropriate to their licensing; the app's
  single network/config seam (`src/config/`) is where such a gate would attach.
- No personal data is collected. Bets are keyed by on-chain account or a platform user id; there is
  no account system, KYC, email capture, or profile store. The chat bots key idempotency by a
  platform message id and attribute bets to a platform user id — no display names, no PII.

## 4. Funds & custody

- The money path is **pure, deterministic contract math** — no LLM ever selects an outcome or sizes
  a payout (`contracts/AUDIT.md` I14). Payouts, fees, bonds and slashing are integer math in Odra.
- Testnet CSPR only. The operator's deployer key funds the agent fleet and house liquidity; this is
  faucet-funded testnet value, not customer money, and there is no customer money to custody.

## 5. Disclosure

- The mainnet build shows an **unaudited hackathon build** banner on every surface and caps per-bet
  size, both driven by the same audit-gated policy (`src/config/caps.ts`). The cap cannot rise above
  the unaudited ceiling until the contracts are audited — this is property-tested, so the disclosure
  can never quietly diverge from the risk.

## 6. Where enforcement lives (one-line map)

| Concern | Enforced in |
|---|---|
| Prohibited market categories | `src/core/category-policy.ts` (Genesis + S23 composer) |
| Per-bet cap + audit gate | `src/config/caps.ts` → `src/config/network.ts` |
| Unaudited disclosure | `src/config/caps.ts` → `src/components/mainnet-banner.tsx` |
| No self-oracle theft | `contracts/src/hunch_vault.rs` `create_market` (I5) |
| Deterministic money path | Odra contracts + `src/core/market-payout.ts` |
| Bug reporting | [`SECURITY.md`](../SECURITY.md) |
