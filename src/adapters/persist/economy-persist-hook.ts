/**
 * Persist-hook registry — the cycle-free seam between the in-process state modules and the KV
 * snapshotter. `economy-state.ts` must import all four state modules (activity log, market
 * source, oracle ledger, settlement ledger) to serialize them, so those modules can NEVER import
 * it back to announce a mutation — that would be a static import cycle. Instead they call
 * `fireEconomyPersistHook()` (this module imports nothing, so it can be imported from anywhere),
 * which defaults to a no-op and is upgraded to "snapshot the economy to KV" the moment
 * `economy-state.ts` loads and registers itself. Unconfigured/never-loaded → mutations stay
 * exactly as cheap as before.
 */

type EconomyPersistHook = () => void;

const NOOP: EconomyPersistHook = () => {};

let hook: EconomyPersistHook = NOOP;

/** Register the persist side-effect fired after every economy mutation. Last registration wins. */
export function setEconomyPersistHook(fn: EconomyPersistHook): void {
  hook = fn;
}

/** Fire the registered hook (no-op until `economy-state.ts` registers). Never throws upstream. */
export function fireEconomyPersistHook(): void {
  try {
    hook();
  } catch {
    /* a persistence failure must never break the mutation that triggered it */
  }
}
