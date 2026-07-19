//! CopyBetting — the on-chain fee split for mirrored volume (S29). When a follower's mirror bet
//! settles, a fee on the mirrored volume is split between the followed agent (its reward for
//! driving the flow) and the platform treasury. This contract is the money authority for that
//! split: it takes the fee as attached CSPR and pays both parties by pure integer math, with
//! conservation as the invariant — `agent + platform == fee`, not a mote minted or lost (dust →
//! platform, so the agent is never overpaid). Mirrors `core/copy-betting.ts::splitCopyFee`.
//!
//! Sizing, guardrails, and the meta-market exclusion live off-chain in `core/copy-betting.ts`; the
//! mirror bet itself settles through the normal vault money path. This contract does one thing —
//! split and pay the copy fee — so it is small and its conservation is easy to prove.
use odra::casper_types::U512;
use odra::prelude::*;

const BPS_DENOMINATOR: u32 = 10_000;

#[odra::odra_error]
pub enum Error {
    /// Caller is not the admin.
    NotAdmin = 1,
    /// Share basis points must be ≤ 100%.
    InvalidShare = 2,
    /// A fee payment must carry non-zero CSPR.
    ZeroFee = 3,
}

/// Emitted on each copy-fee split.
#[odra::event]
pub struct CopyFeePaid {
    /// The followed agent paid its share.
    pub agent: Address,
    /// Total fee split.
    pub fee: U512,
    /// The agent's share.
    pub agent_share: U512,
    /// The platform treasury's share.
    pub platform_share: U512,
}

#[odra::module(events = [CopyFeePaid], errors = Error)]
pub struct CopyBetting {
    admin: Var<Address>,
    treasury: Var<Address>,
    /// The followed agent's cut of the copy fee, in basis points.
    agent_share_bps: Var<u32>,
    /// Lifetime fees paid to each agent (a public earnings record).
    earned: Mapping<Address, U512>,
}

#[odra::module]
impl CopyBetting {
    /// Initialize with a treasury and the agent's share of the copy fee (bps ≤ 10_000).
    pub fn init(&mut self, treasury: Address, agent_share_bps: u32) {
        if agent_share_bps > BPS_DENOMINATOR {
            self.env().revert(Error::InvalidShare);
        }
        self.admin.set(self.env().caller());
        self.treasury.set(treasury);
        self.agent_share_bps.set(agent_share_bps);
    }

    /// Split the attached fee between `agent` and the treasury and pay both. Payable — the attached
    /// value IS the fee on the mirrored volume. Conservation: agent + platform == fee (dust →
    /// platform). Anyone may call it (it only ever pays out the money it was given).
    #[odra(payable)]
    pub fn split_and_pay(&mut self, agent: Address) {
        let fee = self.env().attached_value();
        if fee.is_zero() {
            self.env().revert(Error::ZeroFee);
        }
        let share_bps = self.agent_share_bps.get_or_default();
        let agent_share = fee * U512::from(share_bps) / U512::from(BPS_DENOMINATOR);
        let platform_share = fee - agent_share; // remainder incl. dust → platform

        if !agent_share.is_zero() {
            self.env().transfer_tokens(&agent, &agent_share);
            self.earned
                .set(&agent, self.earned.get_or_default(&agent) + agent_share);
        }
        if !platform_share.is_zero() {
            let treasury = self.treasury.get().unwrap_or_revert(self);
            self.env().transfer_tokens(&treasury, &platform_share);
        }
        self.env().emit_event(CopyFeePaid {
            agent,
            fee,
            agent_share,
            platform_share,
        });
    }

    /// Admin-only: retune the agent's share of the copy fee.
    pub fn set_agent_share_bps(&mut self, bps: u32) {
        if self.env().caller() != self.admin.get().unwrap_or_revert(self) {
            self.env().revert(Error::NotAdmin);
        }
        if bps > BPS_DENOMINATOR {
            self.env().revert(Error::InvalidShare);
        }
        self.agent_share_bps.set(bps);
    }

    /// Lifetime copy fees earned by an agent.
    pub fn earned_by(&self, agent: Address) -> U512 {
        self.earned.get_or_default(&agent)
    }

    /// The agent's current share of the copy fee, in bps.
    pub fn agent_share_bps(&self) -> u32 {
        self.agent_share_bps.get_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::{CopyBetting, CopyBettingHostRef, CopyBettingInitArgs, Error};
    use odra::casper_types::U512;
    use odra::host::{Deployer, HostEnv, HostRef};

    fn deploy(env: &HostEnv, share_bps: u32) -> CopyBettingHostRef {
        env.set_caller(env.get_account(0));
        CopyBetting::deploy(
            env,
            CopyBettingInitArgs {
                treasury: env.get_account(9),
                agent_share_bps: share_bps,
            },
        )
    }

    #[test]
    fn fee_split_conserves_and_pays_both_parties() {
        let env = odra_test::env();
        let mut cb = deploy(&env, 6_000); // agent gets 60%
        let agent = env.get_account(1);
        let treasury = env.get_account(9);
        let payer = env.get_account(2);

        let agent0 = env.balance_of(&agent);
        let treasury0 = env.balance_of(&treasury);

        env.set_caller(payer);
        cb.with_tokens(U512::from(1000u64)).split_and_pay(agent);

        // 60% to agent, 40% to treasury — and they sum to the fee (conservation).
        assert_eq!(env.balance_of(&agent), agent0 + U512::from(600u64));
        assert_eq!(env.balance_of(&treasury), treasury0 + U512::from(400u64));
        assert_eq!(cb.earned_by(agent), U512::from(600u64));
    }

    #[test]
    fn dust_goes_to_the_platform_never_overpaying_the_agent() {
        let env = odra_test::env();
        let mut cb = deploy(&env, 3_333); // 33.33%
        let agent = env.get_account(1);
        let treasury = env.get_account(9);
        let agent0 = env.balance_of(&agent);
        let treasury0 = env.balance_of(&treasury);

        env.set_caller(env.get_account(2));
        cb.with_tokens(U512::from(10u64)).split_and_pay(agent);
        // 10 * 3333 / 10000 = 3 (floored) to agent; 7 to platform. Sum = 10.
        assert_eq!(env.balance_of(&agent), agent0 + U512::from(3u64));
        assert_eq!(env.balance_of(&treasury), treasury0 + U512::from(7u64));
    }

    #[test]
    fn zero_fee_reverts() {
        let env = odra_test::env();
        let mut cb = deploy(&env, 5_000);
        env.set_caller(env.get_account(2));
        assert_eq!(
            cb.try_split_and_pay(env.get_account(1)).unwrap_err(),
            Error::ZeroFee.into()
        );
    }

    #[test]
    fn only_admin_retunes_the_share() {
        let env = odra_test::env();
        let mut cb = deploy(&env, 5_000);
        env.set_caller(env.get_account(3));
        assert_eq!(cb.try_set_agent_share_bps(7_000).unwrap_err(), Error::NotAdmin.into());
        // Admin can.
        env.set_caller(env.get_account(0));
        cb.set_agent_share_bps(7_000);
        assert_eq!(cb.agent_share_bps(), 7_000);
    }
}
