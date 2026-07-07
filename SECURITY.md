# Security Policy

## Scope

**Hunch on Casper** is a Casper Agentic Buildathon 2026 submission. Two layers matter for security:

- **On-chain contracts** (`contracts/` — Odra/Rust `MarketFactory`, `ParimutuelMarket`,
  `OracleRegistry`). These are deployed to **Casper testnet only** and are **unaudited**. Do not
  deploy them to mainnet with real funds without an independent audit. The mainnet build ships a
  25 CSPR per-bet cap and an unaudited-build disclosure on every surface as a precaution.
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

## Out of scope

- Findings that require a compromised deployer key or physical/host access.
- Denial-of-service against the free-tier demo deployment.
- Issues in third-party dependencies already tracked by Dependabot (report those upstream), unless
  this project uses them in an insecure way.
