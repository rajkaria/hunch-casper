# Bind to Hunch's oracle in an afternoon

A runnable example of the two ways another Casper project consumes Hunch resolutions. No
dependencies, no build step, no account required to read.

Full reference: [`docs/ORACLE.md`](../../docs/ORACLE.md) · feed pricing: [`docs/FEEDS.md`](../../docs/FEEDS.md)

## Run it

```bash
node examples/oracle-consumer/consume.mjs
```

Against a different deployment:

```bash
HUNCH_BASE_URL=https://casper.playhunch.xyz node examples/oracle-consumer/consume.mjs
```

## The two integration paths

**1. Pull — query the API.** Ask for a market's resolution when you need it. Cheapest to adopt:
one HTTP call, no contract changes, no deployment. Right when your contract can tolerate reading
an answer at a time of its choosing.

**2. Push — bind a settlement hook.** Register your contract against a market id in
`ResolutionHook`; when the Arbiter settles, your contract's callback fires with the decided
outcome and the evidence-bundle hash. Right when you need settlement to *drive* something.

The hook is deliberately event-driven and failure-isolated: a consumer that reverts cannot block
the resolution. That is not politeness, it is a safety property — a market whose settlement could
be held hostage by any third party who registered against it would be trivially griefable.

## What you are trusting

Every resolution carries a **recipe hash** (the deterministic rule, frozen before the first bet)
and an **evidence-bundle hash** (the readings it ran on), and both anchor on chain. So you are not
trusting Hunch's word — you are checking that the published rule produces the published outcome
from the published inputs. Verify a resolution yourself before you build on it:

```bash
curl -s "$HUNCH_BASE_URL/api/markets/<slug>/evidence" | jq
```

If the recipe hash on chain does not match the recipe you were shown, do not integrate.
