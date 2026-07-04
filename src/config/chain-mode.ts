/**
 * Chain-adapter mode. `mock` (default) uses the deterministic credential-free adapter so CI,
 * local dev, and the deployed demo work with zero secrets. `real` wires the `casper-js-sdk`
 * adapter that signs and submits live Casper transactions — enabled only when an operator
 * sets `CASPER_CHAIN_MODE=real` and provides a funded key + deployed contract addresses.
 *
 * This is a server-only signal: it is read in the composition root and the chain API routes,
 * never shipped to the client.
 */

export type ChainMode = "mock" | "real";

export function chainMode(): ChainMode {
  return process.env.CASPER_CHAIN_MODE === "real" ? "real" : "mock";
}

/** True when settlement runs against the mock adapter (pseudo hashes, no real value moves). */
export function isSimulated(): boolean {
  return chainMode() === "mock";
}
