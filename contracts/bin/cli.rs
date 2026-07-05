//! Deploy + drive the Hunch-on-Casper contracts on a live Casper network (via `odra-cli`).
//!
//! Runs against the **livenet** backend using a funded secret key + node endpoint supplied
//! through env vars (see `contracts/DEPLOY.md`). Deploys **all three** contracts — the
//! `MarketFactory` registry, the `OracleRegistry` (registering the deployer as the "Arbiter"
//! oracle), and a sample `ParimutuelMarket` (the 5-minute coin flip) which it registers into the
//! factory — real on-chain transactions satisfying the S1 qualifier. It is also the S11 bootstrap
//! for a network: the full catalogue is then deployed market-by-market from the
//! `GET /api/deploy-plan?network=` manifest (`markets[]`), the single source of truth.
use contracts::market_factory::MarketFactory;
use contracts::oracle_registry::OracleRegistry;
use contracts::parimutuel_market::{ParimutuelMarket, ParimutuelMarketInitArgs};
use odra::host::{HostEnv, NoArgs};
use odra::prelude::Addressable; // `market.address()` for `register_market`
use odra_cli::{deploy::DeployScript, DeployedContractsContainer, DeployerExt, OdraCli};

/// Far-future deadline (ms) for the sample market so betting stays open during a demo.
const SAMPLE_DEADLINE_MS: u64 = 1_900_000_000_000;
const FACTORY_GAS: u64 = 300_000_000_000;
const ORACLE_GAS: u64 = 300_000_000_000;
const MARKET_GAS: u64 = 400_000_000_000;
const CALL_GAS: u64 = 50_000_000_000;

/// Deploys the registry + oracle registry (with the Arbiter identity) + a sample coin-flip
/// market, and registers the market.
pub struct HunchDeployScript;

impl DeployScript for HunchDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        let deployer = env.caller();

        let mut factory = MarketFactory::load_or_deploy(env, NoArgs, container, FACTORY_GAS)?;

        // Oracle identity + staked reputation. The deployer is admin (set in `init`); register it
        // as the "Arbiter" so the autonomous resolver has an on-chain identity from block one,
        // mirroring the off-chain reputation seed. Idempotent (matches `load_or_deploy`).
        let mut oracle_registry =
            OracleRegistry::load_or_deploy(env, NoArgs, container, ORACLE_GAS)?;
        if !oracle_registry.is_registered(deployer) {
            env.set_gas(CALL_GAS);
            oracle_registry.register_oracle(deployer, "Arbiter".to_string());
        }

        let market = ParimutuelMarket::load_or_deploy(
            env,
            ParimutuelMarketInitArgs {
                question: "Coin flip: HEADS, TAILS or TIE?".to_string(),
                oracle: deployer,
                treasury: deployer,
                fee_bps: 200,
                deadline: SAMPLE_DEADLINE_MS,
                outcomes: vec![
                    "HEADS".to_string(),
                    "TAILS".to_string(),
                    "TIE".to_string(),
                ],
            },
            container,
            MARKET_GAS,
        )?;

        env.set_gas(CALL_GAS);
        factory.register_market(
            "coin-flip-5m".to_string(),
            "Coin flip: HEADS, TAILS or TIE?".to_string(),
            "provably-fair".to_string(),
            market.address(),
            SAMPLE_DEADLINE_MS,
        );

        Ok(())
    }
}

/// CLI entrypoint.
pub fn main() {
    OdraCli::new()
        .about("Deploy + drive the Hunch-on-Casper market contracts")
        .deploy(HunchDeployScript)
        .contract::<MarketFactory>()
        .contract::<OracleRegistry>()
        .contract::<ParimutuelMarket>()
        .build()
        .run();
}
