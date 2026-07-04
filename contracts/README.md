# contracts — Hunch on Casper (Odra / Rust)

Two contracts form the on-chain layer. **All Casper code is original to this buildathon.**

- **`MarketFactory`** (`src/market_factory.rs`) — on-chain registry of markets.
- **`ParimutuelMarket`** (`src/parimutuel_market.rs`) — payable escrow + parimutuel settlement vault.

Deploy runbook (funding, env, deploy, address wiring): **[`DEPLOY.md`](./DEPLOY.md)**.

## Usage
It's recommended to install 
[cargo-odra](https://github.com/odradev/cargo-odra) first.

### Build

```
$ cargo odra build
```
cargo-odra 0.1.7 builds the Casper wasm by default; the result files are placed in the
`${project-root}/wasm` directory. To test the built wasm against a backend, pass `-b`:

### Test
To run test on your local machine, you can basically execute the command:

```
$ cargo odra test
```

To test actual wasm files against a backend, 
you need to specify the backend passing -b argument to `cargo-odra`.

```
$ cargo odra test -b casper
```
