//! Deploy + drive the Hunch-on-Casper contracts on a live Casper network (via `odra-cli`).
//!
//! Runs against the **livenet** backend using a funded secret key + node endpoint supplied
//! through env vars (see `contracts/README.md`). Deploys the `MarketFactory` registry and a
//! sample `ParimutuelMarket` (the 5-minute coin flip), then registers the market — three real
//! on-chain transactions, satisfying the S1 qualifier requirement.
use contracts::market_factory::MarketFactory;
use contracts::parimutuel_market::{ParimutuelMarket, ParimutuelMarketInitArgs};
use odra::host::{HostEnv, HostRef, NoArgs};
use odra_cli::{deploy::DeployScript, DeployedContractsContainer, DeployerExt, OdraCli};

/// Far-future deadline (ms) for the sample market so betting stays open during a demo.
const SAMPLE_DEADLINE_MS: u64 = 1_900_000_000_000;
const FACTORY_GAS: u64 = 300_000_000_000;
const MARKET_GAS: u64 = 400_000_000_000;
const CALL_GAS: u64 = 50_000_000_000;

/// Deploys the registry + a sample coin-flip market and registers it.
pub struct HunchDeployScript;

impl DeployScript for HunchDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        let deployer = env.caller();

        let mut factory = MarketFactory::load_or_deploy(env, NoArgs, container, FACTORY_GAS)?;

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
        .contract::<ParimutuelMarket>()
        .build()
        .run();
}
