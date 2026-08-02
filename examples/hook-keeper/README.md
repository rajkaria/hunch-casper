# Hook keeper — react to a Hunch resolution from your own contract

A ~100-line reference keeper. It watches the `ResolutionHook` for markets you care about and
pushes `settle` into your consumer contract when one resolves.

**Live on Casper testnet:**

| Contract | Package hash |
|---|---|
| `ResolutionHook` | `hash-35e2443be11ac4fed329e216338d702c45bbd8657d8687d1a18a7ed1fc020209` |
| `EscrowConsumer` (reference consumer) | `hash-eda04741636979fe2456e0554a195047082224ba998012b329c89989959f0dac` |

## Why a keeper exists at all

`dispatch` emits events; it does not call your contract. That is deliberate — a synchronous
callback would make the oracle responsible for every consumer's behaviour, so one contract that
reverts could block settlement for everyone bound to that market. Instead the oracle's job ends
when it emits, and each consumer reacts in its own transaction, on its own gas.

The cost is that somebody has to push the button. That somebody is this.

## Why running it is safe, even for a stranger

The keeper passes **no outcome**. `EscrowConsumer::settle(market_id)` reads the decided outcome
from the hook's own state via a cross-contract call, so the keeper cannot influence who gets paid —
it can only pay the gas to make the settlement happen. That means:

- you can run a keeper for a consumer you do not control;
- a competitor running one faster than you gains nothing;
- and a keeper that goes down delays settlement rather than corrupting it.

If you are writing your own consumer, copy that property. A `settle(market_id, outcome)` that
trusts its caller has quietly made every keeper an oracle.

## Run it

```bash
npm i
HOOK=hash-35e2443be11ac4fed329e216338d702c45bbd8657d8687d1a18a7ed1fc020209 \
CONSUMER=hash-eda04741636979fe2456e0554a195047082224ba998012b329c89989959f0dac \
MARKETS=btc-70k-nov,cspr-price-05-aug \
SECRET_KEY_PATH=./keys/secret_key.pem \
node keeper.mjs
```

| Env | Meaning |
|---|---|
| `HOOK` | the `ResolutionHook` package hash |
| `CONSUMER` | your consumer contract's package hash |
| `MARKETS` | comma-separated market ids to watch |
| `SECRET_KEY_PATH` | the key that pays the settle gas — it needs no authority beyond that |
| `NODE_RPC` | defaults to the public testnet node |
| `POLL_MS` | defaults to 30s |

It polls rather than subscribing to the event stream, because polling a handful of markets is
simpler, survives reconnects for free, and settlement is not latency-critical. Subscribe to
`HookNotified` over CSPR.cloud instead if you are watching hundreds.
