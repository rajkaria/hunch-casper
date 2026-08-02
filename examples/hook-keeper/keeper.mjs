/**
 * Reference keeper for Hunch's ResolutionHook (S34/W3).
 *
 * Watches a list of markets, and when the hook reports one dispatched, calls `settle(market_id)`
 * on a consumer contract. That is the whole job.
 *
 * The design property worth copying: this process holds a key that pays gas and NOTHING else. It
 * passes no outcome, because the consumer reads the decided outcome from the hook itself. A keeper
 * that could pass an outcome would be an oracle wearing a relay's clothes — anyone able to call
 * the consumer could settle every escrow in their own favour. Keep the authority in the contract
 * and the keeper stays a dumb, replaceable, permissionless pump.
 *
 * Consequences of that, all good: you can run this for a consumer you do not control, a faster
 * competitor gains nothing, and a keeper outage delays settlement rather than corrupting it.
 */

import { readFileSync } from "node:fs";
import {
  Args,
  CLValue,
  ContractCallBuilder,
  HttpHandler,
  KeyAlgorithm,
  PrivateKey,
  RpcClient,
} from "casper-js-sdk";

const HOOK = requireEnv("HOOK");
const CONSUMER = requireEnv("CONSUMER");
const MARKETS = requireEnv("MARKETS").split(",").map((m) => m.trim()).filter(Boolean);
const SECRET_KEY_PATH = requireEnv("SECRET_KEY_PATH");
const NODE_RPC = process.env.NODE_RPC ?? "https://node.testnet.casper.network/rpc";
const CHAIN_NAME = process.env.CHAIN_NAME ?? "casper-test";
const POLL_MS = Number(process.env.POLL_MS ?? 30_000);

/**
 * Gas for `settle` — a cross-contract read plus one transfer.
 *
 * Measured on chain 2026-08-02 (tx `6dd95ed3…`): 4.220 CSPR consumed, 6.165 net. The original
 * 5 CSPR limit left 1.18x headroom, and an out-of-gas `settle` burns the whole limit for nothing.
 * 8 restores ~1.9x. Casper refunds 75% of the unused slack, so the extra 3 costs ~0.75 CSPR when
 * unused and saves the whole transaction when it is not.
 */
const SETTLE_GAS_MOTES = 8_000_000_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env ${name} — see README.md`);
    process.exit(2);
  }
  return value;
}

/** `hash-<64hex>` / `contract-package-<64hex>` / bare hex → 64-char hex. */
function toHex(address) {
  const hex = address.replace(/^(hash-|contract-package-|contract-)/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a contract hash: ${address}`);
  return hex;
}

const rpc = new RpcClient(new HttpHandler(NODE_RPC));
const key = PrivateKey.fromPem(readFileSync(SECRET_KEY_PATH, "utf8"), KeyAlgorithm.ED25519);

/**
 * Has the hook dispatched this market yet?
 *
 * Read straight from the contract's named dictionary rather than from an event: a state read is
 * idempotent and survives a missed event, whereas a subscription that drops reconnects into a gap.
 * For a handful of markets this is simpler and strictly more robust than streaming.
 */
async function isDispatched(marketId) {
  try {
    const res = await fetch(NODE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "query_global_state",
        params: {
          state_identifier: null,
          key: `hash-${toHex(HOOK)}`,
          path: ["dispatched", marketId],
        },
      }),
    });
    const json = await res.json();
    // Anything unreadable means "not yet" — the safe direction. A false negative costs one more
    // poll; a false positive would submit a settle that reverts and burns gas.
    return json?.result?.stored_value?.CLValue?.parsed === true;
  } catch {
    return false;
  }
}

/** Push the settlement. Returns the transaction hash, or null if it could not be submitted. */
async function settle(marketId) {
  try {
    const tx = new ContractCallBuilder()
      .from(key.publicKey)
      .byPackageHash(toHex(CONSUMER))
      .entryPoint("settle")
      // The ONLY argument. No outcome — the consumer reads that from the hook.
      .runtimeArgs(Args.fromMap({ market_id: CLValue.newCLString(marketId) }))
      .chainName(CHAIN_NAME)
      .payment(SETTLE_GAS_MOTES)
      .build();
    tx.sign(key);
    const res = await rpc.putTransaction(tx);
    return res.transactionHash.toHex();
  } catch (err) {
    console.error(`[keeper] ${marketId}: settle failed —`, err?.message ?? err);
    return null;
  }
}

/** Markets already pushed, so a slow confirmation is not retried into a guaranteed revert. */
const settled = new Set();

async function tick() {
  for (const marketId of MARKETS) {
    if (settled.has(marketId)) continue;
    if (!(await isDispatched(marketId))) continue;

    console.log(`[keeper] ${marketId} dispatched — settling`);
    const hash = await settle(marketId);
    if (hash) {
      // Marked on submission, not on confirmation: `settle` is idempotent on chain
      // (`AlreadySettled`), so the cost of being wrong here is one wasted poll, while retrying a
      // pending settlement every cycle would burn gas on reverts until it confirmed.
      settled.add(marketId);
      console.log(`[keeper] ${marketId} settle submitted: ${hash}`);
    }
  }
}

console.log(
  `[keeper] watching ${MARKETS.length} market(s) on ${CHAIN_NAME}\n` +
    `         hook=${HOOK}\n         consumer=${CONSUMER}\n         signer=${key.publicKey.toHex()}`,
);
await tick();
setInterval(tick, POLL_MS);
