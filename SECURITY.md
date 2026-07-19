# Security Policy

## Scope

**Hunch on Casper** is a Casper Agentic Buildathon 2026 submission. Two layers matter for security:

- **On-chain contracts** (`contracts/` — Odra/Rust `HunchVault` (v2), `ParimutuelMarket`,
  `MarketFactory`, `OracleRegistry`, `AgentRegistry`). These are deployed to **Casper testnet only**
  and are **unaudited**. Do not deploy them to mainnet with real funds without an independent audit.
  The mainnet build ships an audit-gated per-bet cap (25 CSPR while unaudited, `src/config/caps.ts`)
  and an unaudited-build disclosure on every surface as a precaution. The reviewer's starting point
  is the audit bundle: [`contracts/AUDIT.md`](contracts/AUDIT.md) (threat model, invariants,
  entrypoint authority table, accepted risks, coverage map).
- **The web app + agent rails** (`src/` — the x402 payment handshake, the MCP JSON-RPC server, the
  REST API). The public demo runs in deterministic **mock chain mode**, so no real funds move
  through it. The money path is pure, deterministic contract math — no LLM ever selects an outcome
  or touches a payout.

## Supported versions

This is an actively developed hackathon submission. Only the latest `main` is supported. Security
fixes land on `main`; there are no backports.

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ |
| older commits/tags | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use one of the following private channels:

1. **GitHub private vulnerability reporting** (preferred) — open the repository's
   [**Security** tab → **Report a vulnerability**](https://github.com/rajkaria/hunch-casper/security/advisories/new).
   Private vulnerability reporting is enabled on this repository.
2. **Email** — <rajkaria67@gmail.com> with the subject line `SECURITY: hunch-casper`.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof-of-concept, request, or transaction if applicable).
- The affected component (contract, x402 rail, MCP server, API route, UI).
- Any suggested remediation.

## What to expect

- **Acknowledgement** within 72 hours.
- An initial assessment and severity triage shortly after.
- Progress updates as a fix is developed, and public credit once the fix ships (unless you prefer
  to remain anonymous).

## Coordinated disclosure

We follow coordinated disclosure. Please give us a reasonable window to ship a fix before any
public write-up. We will not pursue legal action for good-faith security research that respects
this policy and avoids privacy violations, service degradation, and data destruction.

## Bug-bounty scope

> **Status: unfunded.** This is a testnet hackathon build; there is **no monetary reward pool at
> this time.** The severity ladder below is published so that scope, expectations, and — once a
> funded program opens ahead of any mainnet launch — the reward tiers are unambiguous. Until then,
> valid reports earn acknowledgement, public credit (if desired), and our thanks. Funding a bounty
> is a deliberate operator action, taken alongside the independent audit before mainnet.

**In scope:** the on-chain contracts (`contracts/`), the x402 payment rail (`src/lib/agent-bet.ts`,
`src/adapters/casper/real-payment.ts`), the MCP server (`src/lib/mcp.ts`), the REST API
(`src/app/api/**`), the chat-bot handlers (`src/lib/bot-*.ts`), and the market/settlement core
(`src/core/**`).

| Severity | Definition | Examples | Reward (when funded) |
|---|---|---|---|
| **Critical** | Direct, unauthorised loss of funds; mint/inflation; break of a money-path invariant (§AUDIT I1–I3, I11) | Drain a vault; double-pay a claim; slash beyond bond; bypass the self-oracle guard (I5) to self-resolve and take stakes | top tier |
| **High** | Unauthorised state change without direct theft; auth bypass | Resolve a market you are not the oracle for (I4); admin-only call from a non-admin (I6); replay an x402 payment into a second bet | high tier |
| **Medium** | Griefing, DoS of the money path, or integrity of odds/reputation | Force a market into a stuck state; corrupt the reputation index; bypass the category policy to create a prohibited market | mid tier |
| **Low** | Best-practice deviations with limited impact | Missing input validation with no fund/auth impact; information disclosure of non-sensitive data | low tier / credit |

**Rules of engagement (safe harbour):** we will not pursue legal action for good-faith research
that (a) uses **testnet only** — never touch mainnet funds or others' testnet balances beyond your
own; (b) does not degrade the service for others (no volumetric DoS, no spamming the economy tick);
(c) does not access, modify, or exfiltrate data that is not yours; (d) reports privately via the
channels above and gives us a reasonable window before public disclosure. Research that respects
this policy is authorised; research that violates it is not.

## Out of scope

- Findings that require a compromised deployer/admin key or physical/host access (the admin key is a
  documented trusted party — see `contracts/AUDIT.md` §5).
- Denial-of-service against the free-tier demo deployment (volumetric or resource-exhaustion).
- Issues in third-party dependencies already tracked by Dependabot (report those upstream), unless
  this project uses them in an insecure way.
- The known, documented centralisations in `contracts/AUDIT.md` §5 (admin-gated slashing,
  semi-trusted oracle resolution pre-S25) — these are accepted, disclosed design stages, not bugs.
- The deliberate `simulated`-labelled mock behaviour in demo mode.
