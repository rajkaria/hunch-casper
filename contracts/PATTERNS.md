# Three Odra patterns, with what they cost

Patterns extracted from the ten contracts in this crate, each with the problem it solves, the code
that solves it, and the **measured** price. Costs come from [`docs/GAS.md`](../docs/GAS.md); every
figure is a real testnet transaction, not an estimate.

Written for Casper developers who are not us. Nothing here is Hunch-specific.

---

## 1. Markets as state entries

**Problem.** The obvious model gives each market its own contract. It is clean, it isolates state,
and it costs **324.27 CSPR** per market to install. Anything that wants to create markets on a
schedule — an agent, a cron, a user-facing "new market" button — is dead on arrival at that price.

**Pattern.** One singleton contract; each "instance" is a set of dictionary entries keyed by an id
the caller passes in.

```rust
#[odra::module]
pub struct HunchVault {
    config: Mapping<String, MarketConfig>,        // market_id -> config
    status: Mapping<String, u8>,
    pool: Mapping<(String, String), U512>,        // (market_id, outcome) -> staked
    stake_on: Mapping<(String, String, Address), U512>,
}

impl HunchVault {
    pub fn create_market(&mut self, market_id: String, /* … */) { /* writes config */ }
    pub fn bet(&mut self, market_id: String, outcome: String) { /* every call carries the id */ }
}
```

**Cost.** 373.07 CSPR once for the vault, then **3.74 CSPR** per market. 87× cheaper per market,
and the crossover is at two markets.

**What you give up.** Every entry point grows a `market_id` argument, and a bug in the singleton is
a bug in every market at once — so the test surface is the whole vault, not one market. Isolation
is real; it just is not worth 320 CSPR a market.

**Watch out.** The *first* `create_market` on a fresh vault costs 5.22 CSPR against a steady-state
3.74 — dictionary initialisation. Measure your steady state on the second call, not the first.

---

## 2. Caller-attributed stakes

**Problem.** A contract that records who staked has two options, and only one of them is safe.

**Pattern.**

```rust
pub fn bet(&mut self, market_id: String, outcome: String) {
    let amount = self.env().attached_value();
    let bettor = self.env().caller();          // NOT a parameter
    // …
}
```

Taking the bettor as an *argument* would let anyone credit anyone — and, worse, would make the
whole record meaningless, because nothing on chain would tie a stake to the account that funded it.
`caller()` is the only impersonation-proof choice, and it is what makes `claim()` payable to the
staker without a separate authorisation step.

**The consequence people miss.** Caller-attribution is only as good as your *client*. Hunch signed
every agent's bet with one operator key for months: the contract was correct, and on chain four
agents were one account. If you build a per-actor track record, verify end to end that distinct
actors produce distinct signers — the contract cannot do it for you.

**Cost.** `bet` 3.08 CSPR, `claim` 4.19 CSPR.

---

## 3. Dictionary membership for wide fields

**Problem.** A market over 177 candidates. Storing outcomes as `Vec<String>` means every `bet` call
deserialises the entire list to check membership — cost grows with field width, and a wide enough
field simply cannot be bet on.

**Pattern.** Membership is a dictionary lookup; the list is never read on the hot path.

```rust
#[odra::module]
pub struct FieldMarket {
    candidate: Mapping<String, bool>,   // O(1) membership, whatever the field width
    frozen: Var<bool>,
    commitment: Var<String>,            // hash of the ordered field, fixed at freeze
}

pub fn bet(&mut self, candidate_key: String) {
    if !self.candidate.get_or_default(&candidate_key) { self.env().revert(Error::UnknownCandidate); }
    // …
}
```

Registration is batched (40 keys per call) and the field is **frozen** afterwards, with a
commitment hash written so anyone can verify the field was not edited after betting opened.

**Cost.** ~0.186 CSPR per candidate, **flat in field width** — 40 keys cost 7.458 CSPR, 17 cost
4.734. Whole deploy for 177 candidates: 391.61 CSPR.

**Watch out.** Batch registration is many transactions, and a field left unfrozen is a field an
admin can still edit — so budget the *entire* sequence up front and abort before installing if the
purse cannot cover install + every batch + the freeze. Stranding a contract with an unfreezable
field is worse than not deploying.

---

## 4. Event-emit dispatch instead of callbacks

**Problem.** An oracle that notifies consumer contracts when something resolves. The natural
implementation calls each consumer synchronously, and it has two failure modes that are hard to fix
later: reentrancy, and one broken consumer wedging settlement for everyone.

**Pattern.** Mark dispatched (effects) **before** emitting (interactions), and never call out.

```rust
pub fn dispatch(&mut self, market_id: String, outcome: String, bundle_hash: String) {
    if self.dispatched.get_or_default(&market_id) { self.env().revert(Error::AlreadyDispatched); }
    self.dispatched.set(&market_id, true);      // effects first
    for consumer in self.hooks_for(&market_id) {
        self.env().emit_event(HookNotified { market_id: market_id.clone(), consumer, /* … */ });
    }
}
```

Consumers subscribe to the event and act in their own transaction, on their own gas. Both safety
properties then hold *by construction*: there is no external call to re-enter, and a consumer that
would revert simply fails to act — it cannot block the oracle. `dispatch` is idempotent per market,
so a retried finalisation never double-fires.

**What you give up.** Consumers need an indexer or a keeper; resolution is not atomic with their
reaction. That is the correct trade for an oracle with untrusted consumers.

---

## Reading further

- Measured costs, budgeting rules, and how to reproduce them: [`docs/GAS.md`](../docs/GAS.md)
- Deploy commands for every contract: [`DEPLOY.md`](./DEPLOY.md)
- Invariants, authority model and accepted risks: [`AUDIT.md`](./AUDIT.md)
- The contracts themselves: [`src/`](./src) — 116 OdraVM tests, run with `cargo odra test`
