/**
 * Transaction confirmation — the seam that closed the "paid but never placed" hole.
 *
 * The bug this locks down: `putTransaction` resolves when a node QUEUES a transaction, so a
 * transfer hash handed straight back named a transaction with no execution result. The payment
 * verifier looked it up, found nothing executed, and correctly refused it — after the money had
 * already left the agent's purse. Every assertion here is about never reporting success early and
 * never reporting success for something that failed.
 */

import { describe, it, expect, vi } from "vitest";
import {
  awaitExecution,
  readExecution,
  readExecutionOutcome,
  DEFAULT_CONFIRM_TIMEOUT_MS,
} from "@/adapters/casper/confirm";

/** A Casper 2.0 `info_get_transaction` body with an execution result. */
const executed = (errorMessage: string | null) => ({
  result: {
    transaction: { Version1: { hash: "ab".repeat(32) } },
    execution_info: { execution_result: { Version2: { error_message: errorMessage } } },
  },
});

/** The same transaction, accepted by a node but not yet in a block — no `execution_info`. */
const queued = {
  result: { transaction: { Version1: { hash: "ab".repeat(32) } } },
};

const respond = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("readExecutionOutcome", () => {
  it("reads a successful Casper 2.0 execution", () => {
    expect(readExecutionOutcome(executed(null))).toEqual({ state: "success" });
  });

  it("reads a revert as a failure, carrying the chain's own message", () => {
    expect(readExecutionOutcome(executed("User error: 19"))).toEqual({
      state: "failure",
      error: "User error: 19",
    });
  });

  it("reads a queued-but-unexecuted transaction as pending — THE regression", () => {
    // This exact shape was being treated as a completed payment.
    expect(readExecutionOutcome(queued)).toEqual({ state: "pending" });
  });

  it("reads legacy deploy shapes both ways", () => {
    expect(
      readExecutionOutcome({ result: { deploy: { hash: "x" }, execution_results: [{ result: { Success: {} } }] } }),
    ).toEqual({ state: "success" });
    expect(
      readExecutionOutcome({
        result: { deploy: { hash: "x" }, execution_results: [{ result: { Failure: { error_message: "out of gas" } } }] },
      }),
    ).toEqual({ state: "failure", error: "out of gas" });
  });

  it("never reports success for anything it cannot read", () => {
    // An unknown transaction, an RPC error, a truncated body and garbage all mean the same thing
    // to a caller: you may not act as though this happened.
    for (const body of [null, undefined, "", 42, {}, { error: { code: -32001 } }, { result: {} }]) {
      expect(readExecutionOutcome(body).state).toBe("pending");
    }
  });
});

describe("readExecution", () => {
  it("falls back to the legacy deploy lookup when the 2.0 lookup has nothing", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.method);
      return new Response(
        JSON.stringify(
          body.method === "info_get_transaction"
            ? { error: { code: -32001, message: "transaction not found" } }
            : { result: { deploy: { hash: "x" }, execution_results: [{ result: { Success: {} } }] } },
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    expect(await readExecution("testnet", "ab".repeat(32), { fetchImpl })).toEqual({ state: "success" });
    expect(calls).toEqual(["info_get_transaction", "info_get_deploy"]);
  });

  it("reads an unreachable node as pending, never as success", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await readExecution("testnet", "ab".repeat(32), { fetchImpl })).toEqual({ state: "pending" });
  });
});

describe("awaitExecution", () => {
  it("polls until the transaction executes, then reports success", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      // Queued for the first two reads, mined on the third — the real sequence.
      return new Response(JSON.stringify(call < 3 ? queued : executed(null)), { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await awaitExecution("testnet", "ab".repeat(32), {
      fetchImpl,
      sleepImpl: async () => {},
      intervalMs: 1,
    });
    expect(outcome).toEqual({ state: "success" });
    expect(call).toBe(3);
  });

  it("stops immediately on a revert rather than waiting out the window", async () => {
    const outcome = await awaitExecution("testnet", "ab".repeat(32), {
      fetchImpl: respond(executed("User error: 19")),
      sleepImpl: async () => {},
    });
    expect(outcome).toEqual({ state: "failure", error: "User error: 19" });
  });

  it("gives up as PENDING when the window closes — a timeout is never a success", async () => {
    let clock = 0;
    const outcome = await awaitExecution("testnet", "ab".repeat(32), {
      fetchImpl: respond(queued),
      sleepImpl: async () => {},
      nowImpl: () => (clock += 10_000),
      timeoutMs: 30_000,
    });
    expect(outcome).toEqual({ state: "pending" });
  });

  it("waits long enough for a testnet block by default", () => {
    // Condor testnet blocks land in ~16s; a window shorter than a couple of blocks would
    // reintroduce the race under normal network jitter.
    expect(DEFAULT_CONFIRM_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
