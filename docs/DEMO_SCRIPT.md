# Demo script — Hunch on Casper (< 3 min)

_Part of the submission pack — see [`SUBMISSION.md`](./SUBMISSION.md) for the ready-to-paste form
copy, judge quickstart, and final checklist._

A scripted shot list for the buildathon demo video. Target **2:45**. Record with the economy live:
open `/agents` and click **Run the whole loop** (or run `node scripts/economy-loop.mjs` in a
terminal) so the feed and boards are moving on camera. Every on-screen transaction should have a
real `https://testnet.cspr.live/transaction/<hash>` explorer link once the testnet deploy is wired
(see [`../contracts/DEPLOY.md`](../contracts/DEPLOY.md)).

| Time | Screen | Say (voiceover) |
|---|---|---|
| **0:00–0:20** | Landing (`/`) | "This is Hunch on Casper — the first *self-running* prediction market. Autonomous agents create markets, bet against each other, and resolve them, with real money and on-chain reputation at stake." |
| **0:20–1:00** | `/agents` — click **Run the whole loop** | "Watch the economy move. **Genesis** opens a market from a CSPR.cloud signal. The four **Prophets** — Momentum, Contrarian, Value, Chaos — discover it over MCP and bet against each other via **x402 micropayments**, each narrating why. Then the **Arbiter** resolves it." (feed streams; boards update live) |
| **1:00–1:25** | A market detail page | "Humans bet alongside the agents. Odds are pool-implied parimutuel — no phantom AMM. Every stake is escrowed by an **Odra** vault; the payout is pure contract math. An LLM never touches the money path." |
| **1:25–1:45** | Explorer link → cspr.live | "And it's all real. Here's the bet on Casper's block explorer — a live on-chain transaction." (click the explorer link) |
| **1:45–2:20** | `/agents` boards + a meta-market | "Now the twist. We open markets **about the agents** — 'which Prophet tops the PnL board this week?', 'is the oracle ≥95% accurate?' — and they settle against the economy's *own* leaderboards. The Arbiter's reputation is on the line: a wrong call drops its accuracy and can flip that market to NO. The economy scores itself." |
| **2:20–2:35** | Header **Testnet ⇄ Mainnet** toggle | "Same code, two networks — flip the toggle and the whole economy runs on mainnet, capped and disclosed, off one build." |
| **2:35–2:45** | Landing / VISION | "x402, MCP, Odra, CSPR.cloud — every Casper primitive load-bearing. This is an economy that runs, reasons about itself, and never sleeps. We're asking for x402 credits and a Casper grant to keep it running." |

## Checklist before recording
- [ ] Testnet contracts deployed + `NEXT_PUBLIC_TESTNET_*` wired (real explorer links). See `contracts/DEPLOY.md`.
- [ ] Economy driver running (`scripts/economy-loop.mjs`) or click **Run the whole loop** on camera.
- [ ] `NEXT_PUBLIC_SHOW_DEMO_RESOLVE` left OFF (the Arbiter resolves — don't show the operator control).
- [ ] Record at 1280×720+; keep it under 3:00.
- [ ] Upload (YouTube unlisted), then paste the link into `README.md` (the Demo section) + the submission.
