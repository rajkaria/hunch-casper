//! `EscrowConsumer` — a worked example of binding a contract to a Hunch resolution (S34/W3).
//!
//! This is the smallest useful thing a real protocol does with an oracle: hold money, and release
//! it to one of two parties depending on how a real-world claim resolves. An insurance pool paying
//! out on an event, a lending market liquidating on a price, and an escrow releasing on a delivery
//! are all this contract with different words.
//!
//! It exists so "other Casper protocols can bind to Hunch resolutions" is a thing you can read,
//! deploy and call rather than a claim in a README. Every integration decision it makes is one a
//! real consumer has to make too, and the comments say why each went the way it did.
//!
//! # The flow
//!
//! 1. Someone funds the escrow, naming the market, the outcome that pays the beneficiary, and the
//!    party who gets the money back otherwise.
//! 2. The consumer registers itself with the `ResolutionHook` for that market (one call, once).
//! 3. Hunch finalises the market and the authorised resolver calls `dispatch`, which emits
//!    `HookNotified` per registered consumer.
//! 4. A **keeper** — anyone, on their own gas — observes that event and calls `settle(market_id)`.
//! 5. This contract READS the outcome back from the hook and pays whoever it says, once.
//!
//! # Why a keeper, and why that is not a weakness
//!
//! Step 4 is the part newcomers want to remove: why not have `dispatch` call this contract
//! directly? Because a synchronous callback makes the ORACLE responsible for every consumer's
//! behaviour — one contract that reverts, or burns the gas budget, blocks settlement for everyone
//! bound to that market. Event dispatch inverts it: the oracle's job finishes when it emits, and
//! each consumer reacts in its own transaction, on its own gas, at its own risk.
//!
//! The cost is that settlement here is not atomic with the resolution, and it needs someone to
//! push the button. That is the correct trade whenever the consumer set is untrusted, which for a
//! public oracle it always is.
//!
//! # Why the keeper is not trusted, and why that took a design change
//!
//! The obvious version of `settle` takes the outcome as an argument and checks that the caller is
//! someone we trust. That is wrong twice over: it makes the keeper an oracle (it can pass any
//! outcome it likes), and "someone we trust" is either the resolver — which drags the oracle back
//! into being responsible for every consumer — or the consumer's own relay, which is just moving
//! the trust somewhere less visible.
//!
//! So `settle` takes **only the market id** and reads the outcome from the `ResolutionHook`
//! itself. Anyone may call it, on their own gas, and a liar gains nothing: the value that decides
//! who gets paid comes from the hook's own state, not from the transaction. That required the hook
//! to STORE the decided outcome rather than only emit it, because an event is not readable by a
//! contract — one field, and it is what makes the keeper role permissionless and safe at once.

use odra::prelude::*;
use odra::casper_types::U512;

#[odra::odra_error]
pub enum Error {
    /// The market has not been dispatched by the hook yet — there is no outcome to act on.
    NotDispatched = 1,
    /// This escrow has already paid out — settlement is once and only once.
    AlreadySettled = 2,
    /// No escrow exists for this market.
    UnknownEscrow = 3,
    /// An escrow for this market already exists.
    EscrowExists = 4,
    /// A field was empty or exceeded its bound.
    InvalidField = 5,
    /// Funding an escrow with nothing to escrow.
    ZeroAmount = 6,
}

const MAX_MARKET_ID_LEN: usize = 64;
const MAX_OUTCOME_LEN: usize = 32;

/// Emitted when an escrow is funded and bound to a market's outcome.
#[odra::event]
pub struct EscrowFunded {
    pub market_id: String,
    pub amount: U512,
    pub paying_outcome: String,
    pub beneficiary: Address,
    pub refund_to: Address,
}

/// Emitted when the escrow pays out. `paid_beneficiary` records which way it went.
#[odra::event]
pub struct EscrowSettled {
    pub market_id: String,
    pub decided_outcome: String,
    pub bundle_hash: String,
    pub recipient: Address,
    pub amount: U512,
    pub paid_beneficiary: bool,
}

/// One escrow's terms.
#[odra::odra_type]
pub struct Escrow {
    pub amount: U512,
    /// The outcome key that pays the beneficiary. Anything else refunds.
    pub paying_outcome: String,
    pub beneficiary: Address,
    pub refund_to: Address,
    pub settled: bool,
    /// The evidence-bundle hash the resolution carried, recorded at settlement for audit.
    pub bundle_hash: String,
}

/// The slice of `ResolutionHook` this consumer needs. Declared as an external contract so the
/// call is a real cross-contract read, type-checked at compile time.
#[odra::external_contract]
pub trait ResolutionSource {
    fn is_dispatched(&self, market_id: String) -> bool;
    fn decided_outcome(&self, market_id: String) -> String;
    fn bundle_hash_of(&self, market_id: String) -> String;
}

#[odra::module(events = [EscrowFunded, EscrowSettled])]
pub struct EscrowConsumer {
    /// The `ResolutionHook` this consumer reads its outcomes from.
    ///
    /// This address IS the trust decision, and it is made once, at deploy time, by whoever funds
    /// the escrow — not per-settlement by whoever happens to call.
    hook: External<ResolutionSourceContractRef>,
    /// The same address, kept readable: `External` exposes the calls, not the target.
    hook_addr: Var<Address>,
    escrow: Mapping<String, Escrow>,
}

#[odra::module]
impl EscrowConsumer {
    /// Bind this consumer to the `ResolutionHook` it will read outcomes from.
    pub fn init(&mut self, hook: Address) {
        self.hook.set(hook);
        self.hook_addr.set(hook);
    }

    /// Fund an escrow against a market's outcome. Payable: the attached CSPR is what is escrowed.
    #[odra(payable)]
    pub fn fund(
        &mut self,
        market_id: String,
        paying_outcome: String,
        beneficiary: Address,
        refund_to: Address,
    ) {
        if market_id.is_empty() || market_id.len() > MAX_MARKET_ID_LEN {
            self.env().revert(Error::InvalidField);
        }
        if paying_outcome.is_empty() || paying_outcome.len() > MAX_OUTCOME_LEN {
            self.env().revert(Error::InvalidField);
        }
        if self.escrow.get(&market_id).is_some() {
            self.env().revert(Error::EscrowExists);
        }
        let amount = self.env().attached_value();
        if amount.is_zero() {
            self.env().revert(Error::ZeroAmount);
        }
        self.escrow.set(
            &market_id,
            Escrow {
                amount,
                paying_outcome: paying_outcome.clone(),
                beneficiary,
                refund_to,
                settled: false,
                bundle_hash: String::new(),
            },
        );
        self.env().emit_event(EscrowFunded {
            market_id,
            amount,
            paying_outcome,
            beneficiary,
            refund_to,
        });
    }

    /// Act on a resolution: pay the beneficiary if the decided outcome matches, else refund.
    ///
    /// **Permissionless, and the caller supplies no outcome.** Anyone may push this — a keeper, a
    /// party to the escrow, a passer-by — because the outcome is read from the hook rather than
    /// taken from the transaction. A caller who lies has nothing to lie with; a caller who is
    /// merely fast has no power. All they can do is pay the gas to make the settlement happen,
    /// which is exactly the amount of authority a relay should have.
    ///
    /// Idempotent: `AlreadySettled` after the first call, so a duplicated event cannot double-pay.
    pub fn settle(&mut self, market_id: String) {
        // The cross-contract read that replaces trusting the caller.
        if !self.hook.is_dispatched(market_id.clone()) {
            self.env().revert(Error::NotDispatched);
        }
        let decided_outcome = self.hook.decided_outcome(market_id.clone());
        let bundle_hash = self.hook.bundle_hash_of(market_id.clone());
        let mut escrow = match self.escrow.get(&market_id) {
            Some(e) => e,
            None => self.env().revert(Error::UnknownEscrow),
        };
        if escrow.settled {
            self.env().revert(Error::AlreadySettled);
        }

        // Effects before interactions: mark settled, THEN transfer. The transfer is the only
        // outward call, and a recipient that re-enters finds an escrow already closed.
        let paid_beneficiary = decided_outcome == escrow.paying_outcome;
        let recipient = if paid_beneficiary { escrow.beneficiary } else { escrow.refund_to };
        let amount = escrow.amount;
        escrow.settled = true;
        escrow.bundle_hash = bundle_hash.clone();
        self.escrow.set(&market_id, escrow);

        self.env().transfer_tokens(&recipient, &amount);
        self.env().emit_event(EscrowSettled {
            market_id,
            decided_outcome,
            bundle_hash,
            recipient,
            amount,
            paid_beneficiary,
        });
    }

    /// Read an escrow's terms and status.
    pub fn get_escrow(&self, market_id: String) -> Escrow {
        self.escrow.get(&market_id).unwrap_or_revert_with(self, Error::UnknownEscrow)
    }

    /// The `ResolutionHook` this consumer reads from — the one trust decision it makes.
    pub fn hook_address(&self) -> Address {
        self.hook_addr.get().unwrap_or_revert(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resolution_hook::{ResolutionHook, ResolutionHookHostRef};
    use odra::host::{Deployer, HostEnv, HostRef, NoArgs};

    /// A real hook plus a consumer bound to it — no stubs, because the whole point of this design
    /// is that the consumer reads the hook's actual state.
    fn setup(env: &HostEnv) -> (EscrowConsumerHostRef, ResolutionHookHostRef) {
        let hook = ResolutionHook::deploy(env, NoArgs);
        let consumer = EscrowConsumer::deploy(
            env,
            EscrowConsumerInitArgs { hook: hook.address().clone() },
        );
        (consumer, hook)
    }

    fn funded(env: &HostEnv) -> (EscrowConsumerHostRef, ResolutionHookHostRef, Address, Address) {
        let (mut consumer, hook) = setup(env);
        let beneficiary = env.get_account(1);
        let refund_to = env.get_account(2);
        consumer
            .with_tokens(U512::from(1_000u64))
            .fund("m1".to_string(), "yes".to_string(), beneficiary, refund_to);
        (consumer, hook, beneficiary, refund_to)
    }

    #[test]
    fn pays_the_beneficiary_when_the_decided_outcome_matches() {
        let env = odra_test::env();
        let (mut consumer, mut hook, beneficiary, _) = funded(&env);
        hook.dispatch("m1".to_string(), "yes".to_string(), "sha256:abc".to_string());

        let before = env.balance_of(&beneficiary);
        consumer.settle("m1".to_string());

        assert_eq!(env.balance_of(&beneficiary), before + U512::from(1_000u64));
        assert!(consumer.get_escrow("m1".to_string()).settled);
    }

    #[test]
    fn refunds_when_the_market_resolves_the_other_way() {
        let env = odra_test::env();
        let (mut consumer, mut hook, _, refund_to) = funded(&env);
        hook.dispatch("m1".to_string(), "no".to_string(), String::new());

        let before = env.balance_of(&refund_to);
        consumer.settle("m1".to_string());

        assert_eq!(env.balance_of(&refund_to), before + U512::from(1_000u64));
    }

    /// The property the redesign exists for: a keeper is a relay, not an oracle.
    #[test]
    fn a_stranger_may_settle_and_still_cannot_change_the_outcome() {
        let env = odra_test::env();
        let (mut consumer, mut hook, beneficiary, refund_to) = funded(&env);
        hook.dispatch("m1".to_string(), "no".to_string(), String::new());

        // Someone with no relationship to the escrow pushes the settlement.
        let stranger = env.get_account(3);
        let before_beneficiary = env.balance_of(&beneficiary);
        let before_refund = env.balance_of(&refund_to);
        env.set_caller(stranger);
        consumer.settle("m1".to_string());

        // They paid the gas and moved nothing in their favour: the hook decided, not them.
        assert_eq!(env.balance_of(&beneficiary), before_beneficiary);
        assert_eq!(env.balance_of(&refund_to), before_refund + U512::from(1_000u64));
    }

    #[test]
    fn cannot_settle_before_the_market_is_dispatched() {
        let env = odra_test::env();
        let (mut consumer, _, _, _) = funded(&env);
        assert_eq!(
            consumer.try_settle("m1".to_string()).unwrap_err(),
            Error::NotDispatched.into()
        );
    }

    #[test]
    fn settles_once_and_only_once() {
        let env = odra_test::env();
        let (mut consumer, mut hook, _, _) = funded(&env);
        hook.dispatch("m1".to_string(), "yes".to_string(), String::new());
        consumer.settle("m1".to_string());

        assert_eq!(
            consumer.try_settle("m1".to_string()).unwrap_err(),
            Error::AlreadySettled.into()
        );
    }

    #[test]
    fn records_the_evidence_hash_the_hook_carried() {
        let env = odra_test::env();
        let (mut consumer, mut hook, _, _) = funded(&env);
        hook.dispatch("m1".to_string(), "yes".to_string(), "sha256:deadbeef".to_string());
        consumer.settle("m1".to_string());
        assert_eq!(consumer.get_escrow("m1".to_string()).bundle_hash, "sha256:deadbeef");
    }

    #[test]
    fn refuses_an_escrow_with_nothing_in_it() {
        let env = odra_test::env();
        let (mut consumer, _) = setup(&env);
        assert_eq!(
            consumer
                .try_fund("m1".to_string(), "yes".to_string(), env.get_account(1), env.get_account(2))
                .unwrap_err(),
            Error::ZeroAmount.into()
        );
    }

    #[test]
    fn refuses_a_second_escrow_for_the_same_market() {
        let env = odra_test::env();
        let (mut consumer, _) = setup(&env);
        let b = env.get_account(1);
        let r = env.get_account(2);
        consumer.with_tokens(U512::from(1_000u64)).fund("m1".to_string(), "yes".to_string(), b, r);
        assert_eq!(
            consumer
                .with_tokens(U512::from(1_000u64))
                .try_fund("m1".to_string(), "yes".to_string(), b, r)
                .unwrap_err(),
            Error::EscrowExists.into()
        );
    }

    #[test]
    fn an_unfunded_market_cannot_be_settled() {
        let env = odra_test::env();
        let (mut consumer, mut hook) = setup(&env);
        hook.dispatch("nope".to_string(), "yes".to_string(), String::new());
        assert_eq!(
            consumer.try_settle("nope".to_string()).unwrap_err(),
            Error::UnknownEscrow.into()
        );
    }
}
