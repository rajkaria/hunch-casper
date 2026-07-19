# Probability feeds (S27) — sell the number

The odds themselves are a product: metered live probabilities, an auditable calibration history, and
Casper-native public-good markets. The number the feed sells is the exact pool-implied probability
the vault settles with — never a separate estimate.

## 1. Live feed — `GET /api/odds`

Current pool-implied probabilities for open markets (or one, via `?slug=`), x402-metered through the
shared meter (`lib/query-meter.ts`).

```jsonc
{
  "network": "testnet",
  "count": 18,
  "meter": { "tier": "free", "remainingFree": 19 },
  "odds": [
    { "slug": "cspr-price-05-aug", "question": "CSPR above $0.05 by Aug 1?", "status": "open",
      "poolCspr": 2000,
      "outcomes": [ { "outcomeKey": "yes", "probability": 0.6, "payoutMultiple": 1.67 },
                    { "outcomeKey": "no",  "probability": 0.4, "payoutMultiple": 2.5 } ] }
  ]
}
```

- **Free ecosystem tier** then a `402` x402 challenge (same meter + pricing as the oracle query API,
  S26). `caller` (or `x-oracle-key`) identifies the consumer.
- **Cache:** `s-maxage=30, stale-while-revalidate=120` — a widely-embedded feed stays off origin.

## 2. Calibration history — `GET /api/odds/history`

The feed's audit trail: how well did the crowd's final odds actually predict outcomes? Computes a
reliability curve over every settled market (pure `core/calibration-curve.ts`) plus the Brier/skill
score. Free to read (a public-good record); the *live* number is what's metered.

- JSON by default; `?format=csv` streams the curve as a deterministic CSV (byte-reproducible, so a
  buyer can recompute and verify it). `?bins=` sets bin count (2–20).
- **Expected Calibration Error (ECE)** is the single scalar of trust: when the pools imply 70%, does
  it happen ~70% of the time? Shown, not claimed.

## 3. Casper-native public-good markets

Feeds the ecosystem cares about, added to the catalogue with real recipes (category-policy-clean):

| Slug | Question | Metric |
|---|---|---|
| `casper-condor-upgrade-ships-aug` | Does the Casper 2.0 (Condor) upgrade activate by Aug 1? | `condor_activation_height` |
| `casper-validator-health-90` | Validator-set health above 90%? | `validator_uptime_pct` |
| `casper-grant-milestones-aug` | ≥10 ecosystem grant milestones completed? | `grant_milestones_completed` |

## 4. Media surface

The S21 embed widget (`/embed/[slug]`) renders any of these as a cache-friendly odds card, and the
oEmbed endpoint unfurls a market link into that card — so a feed can live in a blog post, a Discord,
or a dashboard, with a "Bet on this" link carrying attribution.

## 5. Feed economics

See [`docs/OPS.md` §11](OPS.md) for the cost-vs-revenue model: the feed's marginal cost is a read
(cache-fronted, effectively free at the edge), and revenue is the paid-tier x402 per query past the
free allowance. The public-good markets are seeded from house liquidity like any catalogue market;
their value is the ecosystem signal, not fee revenue.
