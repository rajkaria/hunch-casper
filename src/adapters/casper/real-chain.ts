/**
 * Real Casper `CasperChainPort` — signs and submits live transactions to a Casper node via
 * `casper-js-sdk` (v5, Casper 2.0 "Condor" Transaction model). It is the S2 path from the
 * app to the chain: the same port the mock satisfies, so nothing in `core/` or the UI changes
 * when it is wired.
 *
 * SERVER-ONLY BY CONSTRUCTION. This module (and therefore `casper-js-sdk`) is reached only
 * through the lazy dynamic `import()` in `src/lib/container.ts`, which runs exclusively inside
 * server Route Handlers on the Node runtime. That seam keeps the heavy chain SDK out of the
 * client bundle — the same discipline the Sui rail uses in the main Hunch app. Never import
 * this module from a client component.
 *
 * ABI mapping lives in the pure, offline-tested `deploy-plan.ts`; this file is only
 * serialization + signing + submit. The single most delicate piece is the payable `bet`,
 * which Odra 2.8.2 routes through its `proxy_caller_with_return.wasm` session (a direct call
 * would attach ZERO value). See `buildBetPlan`/`usesProxy`.
 *
 * CUSTODY — two paths, and the difference is who signs:
 *
 *  - `placeBet` is **single-custodian**: signed and funded by the one operator key
 *    (`CASPER_BETTOR_KEY`), so on chain the bettor is the operator and `input.bettor` is an
 *    off-chain label only. It is what agents and the demo wallet use. Do NOT expose this path to
 *    untrusted multi-user betting as-is.
 *  - `buildBetTransaction` + `confirmTransaction` are **self-custodial**: the same plan and the
 *    same proxy envelope, built with the visitor's public key as initiator and handed back
 *    unsigned. Their wallet signs, their account pays the gas and the stake, and
 *    `self.env().caller()` is genuinely them — which is what makes `claim` theirs to call.
 *    Per-agent keys (Prophets) are still pending; see the note in `lib/agent-bet.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AccountHash,
  Args,
  CLTypeString,
  CLTypeUInt8,
  CLValue,
  ContractCallBuilder,
  HttpHandler,
  Key,
  KeyAlgorithm,
  NativeTransferBuilder,
  PrivateKey,
  PublicKey,
  RpcClient,
  SessionBuilder,
  type Transaction,
} from "casper-js-sdk";
import type {
  AnchorResolutionInput,
  AnchorResult,
  CasperChainPort,
  CreateMarketInput,
  DeployResult,
  PlaceBetInput,
  PrepareCreateMarketInput,
  ResolveMarketInput,
  TransactionStatus,
  TransferTransactionInput,
  UnsignedBetTransaction,
  UnsignedTransaction,
} from "@/ports/casper-chain";
import type { CasperNetwork } from "@/config/network";
import {
  explorerTransactionUrl,
  getNetworkConfig,
  NATIVE_TRANSFER_MINIMUM_MOTES,
} from "@/config/network";
import { FIELD_MARKET_SLUGS } from "@/core/buildathon-field";
import { TRANSFER_PAYMENT_MOTES } from "./real-wallet";
import {
  buildBetPlan,
  buildCommitBundlePlan,
  buildCommitRecipePlan,
  buildCreateMarketPlan,
  buildResolvePlan,
  resolveMarketTarget,
  type CasperCallArg,
  type CasperCallPlan,
  type MarketCallTarget,
} from "./deploy-plan";
import {
  awaitExecution,
  readExecution,
  type AwaitExecutionOptions,
  type ExecutionOutcome,
} from "./confirm";

/** Thrown when the real adapter is selected but its credentials/addresses are not configured. */
export class CasperConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasperConfigError";
  }
}

/**
 * Thrown when a transaction was submitted but did not end in a successful execution — it reverted,
 * or it had not executed when the confirmation window closed. Carries the hash so an operator can
 * look up what actually happened rather than guessing from a message.
 */
export class CasperSubmitError extends Error {
  constructor(
    message: string,
    readonly transactionHash: string,
  ) {
    super(message);
    this.name = "CasperSubmitError";
  }
}

export interface RealChainOptions {
  /** Ed25519 secret key (PEM contents or 32-byte hex) that signs + funds bets. */
  bettorKey: string;
  /** Ed25519 secret key for the oracle's `resolve`. Falls back to `bettorKey` (single-key demo). */
  oracleKey?: string;
  /** Fallback `ParimutuelMarket` **package** hash for markets not in `marketAddresses`. */
  marketPackageHash: string;
  /** Per-market package hashes (catalogue slug → `hash-<64hex>`), from the deploy manifest. */
  marketAddresses?: Record<string, string>;
  /** The singleton `HunchVault` v2 **package** hash — slugs not in `marketAddresses` route here. */
  vaultV2PackageHash?: string;
  /** The `FieldMarket` **package** hash — the only valid target for a `FIELD_MARKET_SLUGS` slug. */
  fieldMarketPackageHash?: string;
  /** Filesystem path to Odra's `proxy_caller_with_return.wasm` (required for payable bets). */
  proxyWasmPath: string;
  /**
   * Injectable confirmation seam. Every submit waits for the chain to execute before reporting
   * success, so a reverted escrow can never be indexed as a placed bet. Tests stub this.
   */
  confirmImpl?: (hash: string) => Promise<ExecutionOutcome>;
  /** Tuning/injection for the default confirmation poll. */
  confirmOptions?: AwaitExecutionOptions;
}

/** The proxy wasm shipped in-repo (exact Odra 2.8.2 build, from the odra-casper crate). */
const BUNDLED_PROXY_WASM = "src/adapters/casper/resources/proxy_caller_with_return.wasm";

/** Read the real adapter's options from the environment for a given network config. */
export function realChainOptionsFromEnv(
  marketPackageHash: string | undefined,
  marketAddresses?: Record<string, string>,
  vaultV2PackageHash?: string,
  fieldMarketPackageHash?: string,
): RealChainOptions {
  const bettorKey = process.env.CASPER_BETTOR_KEY;
  if (!bettorKey) {
    throw new CasperConfigError("CASPER_BETTOR_KEY is required to submit real Casper transactions");
  }
  if (
    !marketPackageHash &&
    !vaultV2PackageHash &&
    !fieldMarketPackageHash &&
    Object.keys(marketAddresses ?? {}).length === 0
  ) {
    throw new CasperConfigError(
      "no market contracts configured for this network (set NEXT_PUBLIC_*_VAULT_V2, NEXT_PUBLIC_*_VAULT or NEXT_PUBLIC_*_MARKET_ADDRS)",
    );
  }
  // The proxy wasm ships in-repo; CASPER_PROXY_WASM_PATH overrides it only if needed.
  const proxyWasmPath = process.env.CASPER_PROXY_WASM_PATH ?? join(process.cwd(), BUNDLED_PROXY_WASM);
  return {
    bettorKey,
    oracleKey: process.env.CASPER_ORACLE_KEY,
    marketPackageHash: marketPackageHash ?? "",
    marketAddresses,
    vaultV2PackageHash,
    fieldMarketPackageHash,
    proxyWasmPath,
  };
}

function loadKey(pemOrHex: string): PrivateKey {
  const s = pemOrHex.trim();
  return s.includes("BEGIN")
    ? PrivateKey.fromPem(s, KeyAlgorithm.ED25519)
    : PrivateKey.fromHex(s.replace(/^0x/, ""), KeyAlgorithm.ED25519);
}

/** `hash-<64hex>` / raw hex → 64-char hex string (no prefix). */
export function toHexHash(address: string): string {
  const hex = address.replace(/^(hash-|contract-package-|contract-)/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new CasperConfigError(`expected a 32-byte hex contract hash, got: ${address}`);
  }
  return hex;
}

/**
 * An oracle identifier → the `account-hash-…` form the vault stores as a `Key`.
 *
 * `Key::newKey` parses only PREFIXED identifiers, so a bare public key hex — a perfectly ordinary
 * way to name an account, and how `CASPER_ORACLE_ACCOUNT` may well be set — throws while building
 * the transaction rather than being understood. Deriving the account hash needs blake2b, which is
 * why it happens here in the adapter (which already owns the on-chain encoding) instead of in the
 * pure plan builder. Anything already prefixed is passed through untouched: a public key and its
 * account hash are different values and normalising one into the other must be deliberate.
 */
export function toOracleAddress(oracle: string): string {
  const raw = oracle.trim();
  if (/^0[12][0-9a-fA-F]{64,128}$/.test(raw)) {
    return PublicKey.fromHex(raw).accountHash().toPrefixedString();
  }
  return raw;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * One plan arg → its CLValue. An Odra `Address` arg is a `Key`: an `account-hash-…` becomes a
 * Key::Account, a `hash-…` a contract-package key — the two are different on-chain values, so the
 * prefix decides rather than being normalised away.
 */
function clFor(arg: CasperCallArg): CLValue {
  switch (arg.clType) {
    case "u512":
      return CLValue.newCLUInt512(arg.value);
    case "u32":
      return CLValue.newCLUInt32(arg.value);
    case "u64":
      return CLValue.newCLUint64(arg.value);
    case "key":
      return CLValue.newCLKey(Key.newKey(arg.value));
    case "string-list":
      return CLValue.newCLList(
        CLTypeString,
        arg.values.map((v) => CLValue.newCLString(v)),
      );
    default:
      return CLValue.newCLString(arg.value);
  }
}

/** The entry point's own runtime args (e.g. `{ outcome: "heads" }`). */
function entryPointArgs(plan: CasperCallPlan): Args {
  return Args.fromMap(Object.fromEntries(plan.args.map((a) => [a.name, clFor(a)])));
}

/**
 * Casper `Bytes` — `CLType::List(U8)`, NOT `ByteArray(n)`.
 *
 * The distinction is the whole bug. Odra's proxy declares its `args` parameter as
 * `Vec<u8>::cl_type()` (`odra-core::entry_point`), and its own client sends
 * `Bytes::from(args_bytes)` (`odra-casper-rpc-client::transactions`). We sent a fixed-size
 * `ByteArray`, which serialises differently — no length prefix — so the proxy's deserialisation
 * of the inner call failed and every payable call reverted with `ApiError::InvalidArgument`
 * BEFORE reaching the contract. The CLI never hit it because Odra's client builds this envelope
 * itself; only the app's hand-built one was wrong, so the fleet's escrow had never once landed.
 */
function clBytes(bytes: Uint8Array): CLValue {
  return CLValue.newCLList(
    CLTypeUInt8,
    Array.from(bytes, (b) => CLValue.newCLUint8(b)),
  );
}

/**
 * The 5-arg Odra proxy envelope for a payable plan. PURE (no signing/submit) so the money-path
 * invariant — exactly {package_hash, entry_point, args, attached_value, amount}, with
 * `amount === attached_value === stake` and `package_hash` = the 32-byte target — is asserted
 * offline in CI (see `test/proxy-args.test.ts`) without a funded key or a live node.
 *
 * Every name and CLType here mirrors `odra-casper-rpc-client`'s own `runtime_args!` for a proxied
 * call. Treat it as a transcription of that source, not as a design: a divergence does not fail
 * at build time, it reverts on chain after the money has moved.
 */
export function buildProxyArgs(plan: CasperCallPlan): Args {
  return Args.fromMap({
    package_hash: CLValue.newCLByteArray(hexToBytes(toHexHash(plan.targetContract))),
    entry_point: CLValue.newCLString(plan.entryPoint),
    args: clBytes(entryPointArgs(plan).toBytes()),
    attached_value: CLValue.newCLUInt512(plan.attachedMotes),
    amount: CLValue.newCLUInt512(plan.attachedMotes),
  });
}

export function createRealChain(network: CasperNetwork, opts: RealChainOptions): CasperChainPort {
  const cfg = getNetworkConfig(network);
  // TRANSPORT: 'fetch', not the handler's default.
  //
  // The default transport rejected the proxy-session submit from the deployment environment with
  // HTTP 413 "Payload Too Large" — the identical transaction submitted fine from a workstation and
  // the node itself accepts far larger bodies, so the size was never the problem, the client was.
  // Every other chain read this app makes (balances, confirmation polls, signals) already goes over
  // plain fetch and has never failed there, so the submit path now uses the same one.
  const rpc = new RpcClient(new HttpHandler(cfg.nodeRpcUrl, "fetch"));

  /** Where this market's calls go — legacy per-market map first, then the v2 vault, then the legacy fallback. */
  const targetFor = (marketId: string): MarketCallTarget =>
    resolveMarketTarget(marketId, {
      marketAddresses: opts.marketAddresses,
      vaultV2: opts.vaultV2PackageHash,
      fallback: opts.marketPackageHash || undefined,
      fieldMarket: opts.fieldMarketPackageHash,
      fieldMarketSlugs: FIELD_MARKET_SLUGS,
    });

  /**
   * Wait for a transaction to execute and turn the outcome into a result or a throw.
   *
   * Split from `submit` because a transaction the *visitor's wallet* submitted needs exactly the
   * same treatment and none of the submitting: `putTransaction` means "a node queued it", not "it
   * happened", and that is equally true whoever sent it. Reporting success early let a reverted
   * escrow — out of gas, closed market, revert code — be indexed as a placed bet, so the read
   * model claimed money that never moved.
   */
  async function confirm(hash: string): Promise<DeployResult> {
    const outcome = opts.confirmImpl
      ? await opts.confirmImpl(hash)
      : // `deployFallback: false` — every transaction this adapter builds is a Casper 2.0
        // TransactionV1, so `info_get_deploy` cannot answer for one. Asking it on every poll spent
        // a round trip per cycle to learn nothing, with the caller waiting on each.
        await awaitExecution(network, hash, { deployFallback: false, ...opts.confirmOptions });
    if (outcome.state === "failure") {
      throw new CasperSubmitError(`transaction ${hash} reverted on chain: ${outcome.error}`, hash);
    }
    if (outcome.state === "pending") {
      throw new CasperSubmitError(
        `transaction ${hash} did not execute within the confirmation window — check ` +
          `${explorerTransactionUrl(network, hash)} before retrying`,
        hash,
      );
    }
    return { deployHash: hash, explorerUrl: explorerTransactionUrl(network, hash) };
  }

  async function submit(tx: Transaction, key: PrivateKey): Promise<DeployResult> {
    tx.sign(key);
    const res = await rpc.putTransaction(tx);
    return confirm(res.transactionHash.toHex());
  }

  /**
   * Submit a payable plan through Odra's proxy-caller session. The proxy wasm mints a one-time
   * cargo purse from the signer and injects it so the contract's `attached_value()` reads the
   * attached CSPR; a direct package call would attach ZERO — a silent money bug. The five proxy
   * args are exactly what Odra 2.8.2's own client sends, with `amount === attached_value`.
   */
  function buildPayable(plan: CasperCallPlan, from: PublicKey): Transaction {
    return new SessionBuilder()
      .from(from)
      .wasm(readFileSync(opts.proxyWasmPath))
      .runtimeArgs(buildProxyArgs(plan))
      .chainName(cfg.chainName)
      .payment(Number(plan.gasMotes))
      .build();
  }

  function submitPayable(plan: CasperCallPlan, key: PrivateKey): Promise<DeployResult> {
    return submit(buildPayable(plan, key.publicKey), key);
  }

  return {
    network,

    async getBlockHeight(): Promise<number> {
      const res = await rpc.getLatestBlock();
      return Number(res.block.height);
    },

    /** Payable `bet` → an Odra proxy session carrying the stake. */
    async placeBet(input: PlaceBetInput): Promise<DeployResult> {
      const key = loadKey(opts.bettorKey);
      const target = targetFor(input.marketId);
      const plan = buildBetPlan(input, {
        marketContract: target.contract,
        vaultMarketId: target.vaultMarketId,
      });
      return submitPayable(plan, key);
    },

    /**
     * The same escrow, handed back the moment a node accepts it. Identical plan, identical
     * envelope, identical key — the ONLY difference from `placeBet` is that it does not wait for
     * execution, so the caller can show a hash now and confirm it separately.
     */
    async submitBet(input: PlaceBetInput): Promise<DeployResult> {
      const key = loadKey(opts.bettorKey);
      const target = targetFor(input.marketId);
      const plan = buildBetPlan(input, {
        marketContract: target.contract,
        vaultMarketId: target.vaultMarketId,
      });
      const tx = buildPayable(plan, key.publicKey);
      tx.sign(key);
      const res = await rpc.putTransaction(tx);
      const hash = res.transactionHash.toHex();
      return { deployHash: hash, explorerUrl: explorerTransactionUrl(network, hash) };
    },

    /**
     * The same bet, built for the visitor's own key and left unsigned.
     *
     * Identical plan, identical proxy envelope, identical gas — the ONLY difference from
     * `placeBet` is the initiator and who signs. That is deliberate: the money path's ABI must not
     * fork depending on who is paying, or the wallet-signed bet would be a second, less-tested
     * encoding of the same call.
     */
    async buildBetTransaction(input: PlaceBetInput): Promise<UnsignedBetTransaction> {
      const target = targetFor(input.marketId);
      const plan = buildBetPlan(input, {
        marketContract: target.contract,
        vaultMarketId: target.vaultMarketId,
      });
      const tx = buildPayable(plan, PublicKey.fromHex(input.bettor));
      const json = tx.toJSON();
      return {
        transactionJson: JSON.stringify(json),
        // The hash covers the payload; approvals are appended to a signed copy and do not change
        // it. So this is the hash the transaction will carry on chain once the wallet signs it.
        transactionHash: tx.hash.toHex(),
        gasMotes: plan.gasMotes,
      };
    },

    /**
     * The x402 creation bond as a native transfer the VISITOR signs — same construction as the
     * fleet's own transfers (`real-wallet.ts`), minus the key.
     *
     * The chainspec floor is checked here rather than left to the node: below it the submit comes
     * back as a raw `-32016`, from inside a wallet popup, with nothing on screen to explain it. A
     * bond that cannot be transferred is an operator misconfiguration and says so.
     */
    async buildTransferTransaction(input: TransferTransactionInput): Promise<UnsignedTransaction> {
      const amount = BigInt(input.amountMotes);
      if (amount < NATIVE_TRANSFER_MINIMUM_MOTES) {
        throw new CasperConfigError(
          `a transfer of ${amount} motes is below the chainspec native-transfer minimum of ` +
            `${NATIVE_TRANSFER_MINIMUM_MOTES} motes (2.5 CSPR) — the node would reject it ` +
            `(-32016 insufficient transfer amount)`,
        );
      }
      const builder = new NativeTransferBuilder()
        .from(PublicKey.fromHex(input.from.trim()))
        .amount(input.amountMotes)
        .chainName(cfg.chainName)
        .payment(TRANSFER_PAYMENT_MOTES);

      // A public key and an account-hash are different values (deriving one needs blake2b), so the
      // recipient's form decides the builder call rather than being normalised into one shape.
      const to = input.to.trim();
      if (/^account-hash-[0-9a-fA-F]{64}$/.test(to)) {
        builder.targetAccountHash(AccountHash.fromString(to));
      } else {
        builder.target(PublicKey.fromHex(to));
      }

      const tx = builder.build();
      return {
        transactionJson: JSON.stringify(tx.toJSON()),
        // Final before the signature, exactly as in `buildBetTransaction` — so the receipt and the
        // x402 proof can both name it the moment the wallet accepts.
        transactionHash: tx.hash.toHex(),
        gasMotes: String(TRANSFER_PAYMENT_MOTES),
      };
    },

    /** Confirm a transaction a visitor's wallet submitted. Same semantics as our own submits. */
    async confirmTransaction(transactionHash: string): Promise<DeployResult> {
      return confirm(transactionHash);
    },

    /**
     * One read of what the chain says about a transaction — no waiting, no polling. The route that
     * indexes a wallet-signed bet calls this on each poll from the browser, so the visitor holds a
     * receipt with a working explorer link for the 8-16s the chain takes, instead of a spinner.
     */
    async checkTransaction(transactionHash: string): Promise<TransactionStatus> {
      const outcome = opts.confirmImpl
        ? await opts.confirmImpl(transactionHash)
        : await readExecution(network, transactionHash, {
            deployFallback: false,
            ...opts.confirmOptions,
          });
      if (outcome.state === "failure") return { status: "reverted", error: outcome.error };
      if (outcome.state === "pending") return { status: "pending" };
      return {
        status: "confirmed",
        result: {
          deployHash: transactionHash,
          explorerUrl: explorerTransactionUrl(network, transactionHash),
        },
      };
    },

    /**
     * Payable `create_market` → an Odra proxy session carrying the creation bond. Routing is
     * forced to the v2 vault rather than going through `targetFor`: a fresh slug is by definition
     * absent from the per-market address map, and a market that does not exist yet cannot be
     * "resolved" to a contract by the normal path. `buildCreateMarketPlan` rejects a non-vault
     * target, so a misconfigured deployment fails at plan time with a message naming the fix,
     * instead of on chain with a revert code.
     */
    async createMarket(input: CreateMarketInput): Promise<DeployResult> {
      if (!opts.vaultV2PackageHash) {
        throw new CasperConfigError(
          "runtime market creation needs the singleton HunchVault v2 — set NEXT_PUBLIC_*_VAULT_V2 " +
            "(a v1 per-market package has no create_market entry point)",
        );
      }
      const key = loadKey(opts.bettorKey);
      const plan = buildCreateMarketPlan(
        { ...input, oracle: toOracleAddress(input.oracle) },
        { marketContract: opts.vaultV2PackageHash, vaultMarketId: input.marketId },
      );
      return submitPayable(plan, key);
    },

    /**
     * The same `create_market`, built for the visitor's own key and left unsigned.
     *
     * Identical plan, identical proxy envelope, identical gas — the ONLY difference from
     * `createMarket` above is the initiator and who signs, exactly as `buildBetTransaction`
     * mirrors `placeBet`. The signer funds the gas AND the attached bond, and becomes
     * `env().caller()` — the account the vault refunds the bond to at clean settlement, which is
     * the whole point of this method existing.
     */
    async buildCreateMarketTransaction(input: PrepareCreateMarketInput): Promise<UnsignedTransaction> {
      if (!opts.vaultV2PackageHash) {
        throw new CasperConfigError(
          "runtime market creation needs the singleton HunchVault v2 — set NEXT_PUBLIC_*_VAULT_V2 " +
            "(a v1 per-market package has no create_market entry point)",
        );
      }
      const plan = buildCreateMarketPlan(
        { ...input, oracle: toOracleAddress(input.oracle) },
        { marketContract: opts.vaultV2PackageHash, vaultMarketId: input.marketId },
      );
      const tx = buildPayable(plan, PublicKey.fromHex(input.creator.trim()));
      return {
        transactionJson: JSON.stringify(tx.toJSON()),
        // Final before the signature — what the creation ticket binds and the receipt shows.
        transactionHash: tx.hash.toHex(),
        gasMotes: plan.gasMotes,
      };
    },

    /** Non-payable `resolve` → a direct package-targeting transaction, signed by the oracle key. */
    async resolveMarket(input: ResolveMarketInput): Promise<DeployResult> {
      const key = loadKey(opts.oracleKey ?? opts.bettorKey);
      const target = targetFor(input.marketId);
      const plan = buildResolvePlan(input, {
        marketContract: target.contract,
        vaultMarketId: target.vaultMarketId,
      });
      const tx = new ContractCallBuilder()
        .from(key.publicKey)
        .byPackageHash(toHexHash(plan.targetContract))
        .entryPoint(plan.entryPoint)
        .runtimeArgs(entryPointArgs(plan))
        .chainName(cfg.chainName)
        .payment(Number(plan.gasMotes))
        .build();
      return submit(tx, key);
    },

    /**
     * Anchor the resolution's recipe + evidence hashes (S24).
     *
     * Deliberately total: every failure path returns rather than throws. The caller has already
     * paid winners at this point, and letting a metadata write abort that would be exactly
     * backwards — the same reasoning that keeps resolution itself outside the cadence throttle.
     */
    async anchorResolution(input: AnchorResolutionInput): Promise<AnchorResult> {
      const target = targetFor(input.marketId);
      // `commit_recipe`/`commit_bundle` exist only on the v2 vault; a per-market v1 package has no
      // such entrypoint, so calling it there would burn gas on a guaranteed revert.
      if (!target.vaultMarketId) {
        return { skipped: "market routes to a v1 package, which has no commit entrypoints" };
      }
      const key = loadKey(opts.oracleKey ?? opts.bettorKey);
      const planOpts = { marketContract: target.contract, vaultMarketId: target.vaultMarketId };

      const send = async (plan: CasperCallPlan): Promise<string | undefined> => {
        try {
          const tx = new ContractCallBuilder()
            .from(key.publicKey)
            .byPackageHash(toHexHash(plan.targetContract))
            .entryPoint(plan.entryPoint)
            .runtimeArgs(entryPointArgs(plan))
            .chainName(cfg.chainName)
            .payment(Number(plan.gasMotes))
            .build();
          return (await submit(tx, key)).deployHash;
        } catch (err) {
          console.warn(
            "[anchor] %s did not land — the resolution still paid out:",
            plan.entryPoint,
            JSON.stringify({ marketId: input.marketId }),
            err,
          );
          return undefined;
        }
      };

      const recipeDeployHash = input.recipeHash
        ? await send(buildCommitRecipePlan(input.marketId, input.recipeHash, planOpts))
        : undefined;
      const bundleDeployHash = input.bundleHash
        ? await send(buildCommitBundlePlan(input.marketId, input.bundleHash, planOpts))
        : undefined;

      return recipeDeployHash || bundleDeployHash
        ? { recipeDeployHash, bundleDeployHash }
        : { recipeDeployHash, bundleDeployHash, skipped: "no anchor landed" };
    },

    explorerUrlForDeploy(deployHash: string): string {
      return explorerTransactionUrl(network, deployHash);
    },
  };
}
