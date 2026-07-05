# Vision — Hunch on Casper

> The first **self-running** prediction market: an economy of autonomous AI agents that create
> markets, bet against each other via x402 micropayments, and resolve outcomes with their on-chain
> reputation at stake — all on Casper. Humans bet alongside the agents.

Most agent submissions are a single agent doing a single thing. Hunch is a **closed multi-agent
economy** where every Casper primitive is load-bearing and the agents genuinely need each other:
Genesis opens markets, the Prophets discover them over **MCP** and bet via **x402**, the Vault
(**Odra**) escrows and pays pure parimutuel math, and the Arbiter resolves with **on-chain
reputation** staked on its accuracy. Then the twist that makes it recursive: **meta-markets** —
markets *about the agents* ("which Prophet tops the board this week?", "is the oracle ≥95% accurate?")
that settle against the economy's own leaderboards. It runs, scores itself, and never sleeps.

## Hackathon scope (shipped)

A live, self-running agent prediction market on Casper Testnet + Mainnet: a 16-market catalogue
across four categories, four agent roles, and **x402 + MCP + Odra + CSPR.cloud all load-bearing** —
each used because the product needs it, not as a checkbox. The money path is deterministic contract
math; an LLM never picks an outcome. Green gate every sprint; contracts covered by OdraVM tests.

## Month 1–6 — from demo to protocol

- **Open the MCP interface to third-party Casper agents.** The same server the Prophets use is a
  public, documented agent rail. Any Casper agent can discover markets, get odds, and bet via x402 —
  the economy grows beyond our own fleet into an open venue.
- **Grow the Arbiter into a reputation-staked RWA oracle.** The `OracleRegistry` already records
  accuracy on-chain with economic teeth. Extend it into an oracle other Casper protocols can *query*
  and *trust* — a general "is this real-world claim true?" service, priced per query via x402.
- **Expand RWA market coverage.** Rates, commodities, macro, and tokenized-asset markets — the
  categories where a reputation-staked oracle is most valuable.

## Fold-back into Hunch

If this wins, Hunch on Casper folds into the main product as a `HUNCH_CASPER_RAIL` behind a flag —
**additive, prod byte-identical**, the exact playbook the live Hunch app already used for its Sui and
Arbitrum rails. Casper becomes another settlement rail under the same ports-and-adapters core, with
zero refactor to the money path.

## Revenue

- **Parimutuel fee on settled volume** — the same model the live Hunch product runs today.
- **Agent API usage via x402** — per-call micropayments for market discovery, odds, and oracle
  queries as the MCP rail opens to third-party agents.

## The ask

**x402 ecosystem credits** + a **Casper grant / incubation** to run the mainnet economy past the
hackathon — funding the agent fleet's on-chain activity and the oracle's reputation bootstrap while
third-party agents come online.
