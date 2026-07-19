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
 * CUSTODY (S2 scope): real mode is **single-custodian** — every `bet` is signed and funded by
 * the one operator key (`CASPER_BETTOR_KEY`), so on-chain the bettor is the operator, not the
 * end user. `input.bettor` is an off-chain label only. This is correct for the S2 qualifier
 * (the operator demonstrates one real bet + resolution); genuine per-user custody, where each
 * user's own wallet signs so `self.env().caller()` is the real bettor and they can `claim`,
 * requires CSPR.click connect (humans) / per-agent keys (Prophets) and lands in S4/S7. Do NOT
 * expose this real path to untrusted multi-user betting as-is.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Args,
  CLTypeString,
  CLValue,
  ContractCallBuilder,
  HttpHandler,
  Key,
  KeyAlgorithm,
  PrivateKey,
  RpcClient,
  SessionBuilder,
  type Transaction,
} from "casper-js-sdk";
import type {
  CasperChainPort,
  CreateMarketInput,
  DeployResult,
  PlaceBetInput,
  ResolveMarketInput,
} from "@/ports/casper-chain";
import type { CasperNetwork } from "@/config/network";
import { explorerTransactionUrl, getNetworkConfig } from "@/config/network";
import {
  buildBetPlan,
  buildCreateMarketPlan,
  buildResolvePlan,
  resolveMarketTarget,
  type CasperCallArg,
  type CasperCallPlan,
  type MarketCallTarget,
} from "./deploy-plan";

/** Thrown when the real adapter is selected but its credentials/addresses are not configured. */
export class CasperConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasperConfigError";
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
  /** Filesystem path to Odra's `proxy_caller_with_return.wasm` (required for payable bets). */
  proxyWasmPath: string;
}

/** The proxy wasm shipped in-repo (exact Odra 2.8.2 build, from the odra-casper crate). */
const BUNDLED_PROXY_WASM = "src/adapters/casper/resources/proxy_caller_with_return.wasm";

/** Read the real adapter's options from the environment for a given network config. */
export function realChainOptionsFromEnv(
  marketPackageHash: string | undefined,
  marketAddresses?: Record<string, string>,
  vaultV2PackageHash?: string,
): RealChainOptions {
  const bettorKey = process.env.CASPER_BETTOR_KEY;
  if (!bettorKey) {
    throw new CasperConfigError("CASPER_BETTOR_KEY is required to submit real Casper transactions");
  }
  if (!marketPackageHash && !vaultV2PackageHash && Object.keys(marketAddresses ?? {}).length === 0) {
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
 * The 5-arg Odra proxy envelope for a payable plan. PURE (no signing/submit) so the money-path
 * invariant — exactly {package_hash, entry_point, args, attached_value, amount}, with
 * `amount === attached_value === stake` and `package_hash` = the 32-byte target — is asserted
 * offline in CI (see `test/proxy-args.test.ts`) without a funded key or a live node.
 */
export function buildProxyArgs(plan: CasperCallPlan): Args {
  return Args.fromMap({
    package_hash: CLValue.newCLByteArray(hexToBytes(toHexHash(plan.targetContract))),
    entry_point: CLValue.newCLString(plan.entryPoint),
    args: CLValue.newCLByteArray(entryPointArgs(plan).toBytes()),
    attached_value: CLValue.newCLUInt512(plan.attachedMotes),
    amount: CLValue.newCLUInt512(plan.attachedMotes),
  });
}

export function createRealChain(network: CasperNetwork, opts: RealChainOptions): CasperChainPort {
  const cfg = getNetworkConfig(network);
  const rpc = new RpcClient(new HttpHandler(cfg.nodeRpcUrl));

  /** Where this market's calls go — legacy per-market map first, then the v2 vault, then the legacy fallback. */
  const targetFor = (marketId: string): MarketCallTarget =>
    resolveMarketTarget(marketId, {
      marketAddresses: opts.marketAddresses,
      vaultV2: opts.vaultV2PackageHash,
      fallback: opts.marketPackageHash || undefined,
    });

  async function submit(tx: Transaction, key: PrivateKey): Promise<DeployResult> {
    tx.sign(key);
    const res = await rpc.putTransaction(tx);
    const hash = res.transactionHash.toHex();
    return { deployHash: hash, explorerUrl: explorerTransactionUrl(network, hash) };
  }

  /**
   * Submit a payable plan through Odra's proxy-caller session. The proxy wasm mints a one-time
   * cargo purse from the signer and injects it so the contract's `attached_value()` reads the
   * attached CSPR; a direct package call would attach ZERO — a silent money bug. The five proxy
   * args are exactly what Odra 2.8.2's own client sends, with `amount === attached_value`.
   */
  function submitPayable(plan: CasperCallPlan, key: PrivateKey): Promise<DeployResult> {
    const tx = new SessionBuilder()
      .from(key.publicKey)
      .wasm(readFileSync(opts.proxyWasmPath))
      .runtimeArgs(buildProxyArgs(plan))
      .chainName(cfg.chainName)
      .payment(Number(plan.gasMotes))
      .build();
    return submit(tx, key);
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
      const plan = buildCreateMarketPlan(input, {
        marketContract: opts.vaultV2PackageHash,
        vaultMarketId: input.marketId,
      });
      return submitPayable(plan, key);
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

    explorerUrlForDeploy(deployHash: string): string {
      return explorerTransactionUrl(network, deployHash);
    },
  };
}
