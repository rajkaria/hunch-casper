/**
 * Fixtures are VERBATIM live CSPR.cloud responses (testnet vault v2 `ce451360…`, captured
 * 2026-07-24 and 2026-07-25) including genuinely reverted calls. Per AGENTS.md, an upstream parser
 * is asserted against the real payload — the `/auction-metrics` bug survived a green gate precisely
 * because its test mocked an invented shape, and the settlement blindness fixed here is the same
 * failure again: the proxied row shape was the only one anybody had looked at.
 */

import { describe, expect, it, vi } from "vitest";
import {
  decodeDeployEvent,
  decodeDeployEvents,
  decodeEntryPoints,
  sortEvents,
  bareHash,
  createDeployEvents,
} from "@/adapters/casper/deploy-events";
import { computeStats } from "@/core/stats";
import rows from "./fixtures/cspr-cloud-deploys.json";
import storedRows from "./fixtures/cspr-cloud-stored-deploys.json";
import entryPointsPage from "./fixtures/cspr-cloud-entry-points.json";
import entryPointsDefaultPage from "./fixtures/cspr-cloud-entry-points-default-page.json";

const BET = rows[0];
const CREATE = rows[1];
const REVERTED = rows[2];

// Stored-contract calls: no `entry_point` argument anywhere, only `entry_point_id`.
const RESOLVE = storedRows[0]; // d0bda096… — resolved cspr-hourly-updown#20658 as "down"
const CLAIM = storedRows[1]; // 1364254c… — claimed on receipts-vault-v2
const APPROVE_ORACLE = storedRows[2]; // be3f2068… — a real call this fold must NOT index
const RESOLVE_REVERTED = storedRows[3]; // c050552e… — reverted "User error: 5"

const NAMES = decodeEntryPoints(entryPointsPage);
/** The vault's real ids, read off the live table — `resolve` is 2735470. */
const ID = Object.fromEntries([...NAMES].map(([id, name]) => [name, id])) as Record<string, number>;

describe("decodeDeployEvent — live payloads", () => {
  it("folds a successful bet, with its market, outcome, stake and bettor", () => {
    const e = decodeDeployEvent(BET)!;
    expect(e.kind).toBe("bet_placed");
    expect(e.marketId).toBe("cspr-mcap-1b-aug");
    expect(e.outcomeKey).toBe("yes");
    expect(e.amountMotes).toBe("3000000000");
    expect(e.bettor).toBeTruthy();
    expect(e.blockHeight).toBe(8592429);
  });

  it("folds a market creation with its fee and outcomes", () => {
    const e = decodeDeployEvent(CREATE)!;
    expect(e.kind).toBe("market_created");
    expect(e.feeBps).toBe(200);
    expect(e.outcomeKeys).toEqual(["yes", "no"]);
  });

  it("NEVER folds a reverted call", () => {
    // This row really reverted on chain (ApiError::InvalidArgument [3]) — no money moved. Folding
    // it would put a stake on the boards that no vault is holding.
    expect(REVERTED.error_message).toBeTruthy();
    expect(decodeDeployEvent(REVERTED)).toBeNull();
  });

  it("drops rows with no mapped entry point", () => {
    expect(decodeDeployEvent({ ...BET, args: { ...BET.args, entry_point: { parsed: "admin" } } })).toBeNull();
  });

  it("drops rows missing an ordering key", () => {
    expect(decodeDeployEvent({ ...BET, block_height: undefined })).toBeNull();
    expect(decodeDeployEvent({ ...BET, deploy_hash: undefined })).toBeNull();
  });

  it("never throws on junk", () => {
    for (const junk of [null, undefined, 42, "x", [], {}]) {
      expect(() => decodeDeployEvent(junk)).not.toThrow();
      expect(decodeDeployEvent(junk)).toBeNull();
    }
  });

  it("decodes a whole page and skips the reverted row", () => {
    expect(decodeDeployEvents({ data: rows })).toHaveLength(2);
  });
});

describe("entry-point table — the id the stored rows are keyed by", () => {
  it("maps the vault's real ids to names", () => {
    expect(NAMES.get(2735470)).toBe("resolve");
    expect(NAMES.get(2735451)).toBe("claim");
    expect(NAMES.size).toBe(32);
  });

  it("NEVER throws on junk", () => {
    for (const junk of [null, undefined, 42, "x", {}, { data: 7 }, [1, "a", null]]) {
      expect(() => decodeEntryPoints(junk)).not.toThrow();
    }
  });

  it("the endpoint's DEFAULT page does not contain `resolve` — the trap this fold must not fall in", () => {
    // Verbatim response with no page_size: ten rows, ending at `deadline_of`. An adapter that reads
    // the default page decodes every resolution to null through a code path that looks correct.
    const short = decodeEntryPoints(entryPointsDefaultPage);
    expect(short.size).toBe(10);
    expect([...short.values()]).not.toContain("resolve");
    expect(decodeDeployEvent(RESOLVE, short)).toBeNull();
  });
});

describe("decodeDeployEvent — stored calls (resolve / claim / void)", () => {
  it("folds a resolution: THE row the landing page reported as `Rounds settled: 0`", () => {
    const e = decodeDeployEvent(RESOLVE, NAMES)!;
    expect(e.kind).toBe("market_resolved");
    expect(e.marketId).toBe("cspr-hourly-updown#20658");
    expect(e.outcomeKey).toBe("down");
    expect(e.voided).toBe(false);
    expect(e.oracleId).toBe(RESOLVE.caller_public_key);
    expect(e.blockHeight).toBe(8614597);
    expect(e.deployHash).toBe("d0bda0963083c81d32501b3b046b3c66ef1a5fc97add8dd9ba6069cf9bd230f8");
    expect(e.timestampMs).toBe(Date.parse("2026-07-25T00:01:41Z"));
  });

  it("folds a payout claim, and does NOT invent an amount from the gas budget", () => {
    const e = decodeDeployEvent(CLAIM, NAMES)!;
    expect(e.kind).toBe("payout_claimed");
    expect(e.marketId).toBe("receipts-vault-v2");
    expect(e.claimant).toBe(CLAIM.caller_public_key);
    // `payment_amount` is 8000000000 motes of gas on this very row. Reading it as a payout would
    // publish 8 CSPR of "paid out" that no winner ever received.
    expect(CLAIM.payment_amount).toBe("8000000000");
    expect(e.amountMotes).toBeUndefined();
  });

  it("drops a stored row when the entry-point table is unavailable, rather than guessing", () => {
    expect(decodeDeployEvent(RESOLVE)).toBeNull();
    expect(decodeDeployEvent(CLAIM, new Map())).toBeNull();
  });

  it("NEVER folds a reverted resolution", () => {
    expect(RESOLVE_REVERTED.error_message).toBe("User error: 5");
    expect(decodeDeployEvent(RESOLVE_REVERTED, NAMES)).toBeNull();
  });

  it("drops a real-but-unmapped stored call", () => {
    // approve_oracle is a genuine admin call on this contract; it is not money and not an outcome.
    expect(NAMES.get(APPROVE_ORACLE.entry_point_id)).toBe("approve_oracle");
    expect(decodeDeployEvent(APPROVE_ORACLE, NAMES)).toBeNull();
  });

  it("reads a void as a settled round with no winner", () => {
    // Synthesised from the verbatim resolve row: nothing has been voided on chain yet, so only the
    // entry-point id and the argument list (void takes market_id alone) come from the live vault.
    const voided = {
      ...RESOLVE,
      entry_point_id: ID.void,
      args: { market_id: RESOLVE.args.market_id },
    };
    const e = decodeDeployEvent(voided, NAMES)!;
    expect(e.kind).toBe("market_resolved");
    expect(e.voided).toBe(true);
    expect(e.outcomeKey).toBeUndefined();
    expect(e.marketId).toBe("cspr-hourly-updown#20658");
  });

  it("reads a refund as a payout claim — the vault's own alias for the voided claim branch", () => {
    const e = decodeDeployEvent({ ...CLAIM, entry_point_id: ID.refund }, NAMES)!;
    expect(e.kind).toBe("payout_claimed");
    expect(e.claimant).toBe(CLAIM.caller_public_key);
  });

  it("closes the loop for `computeStats`: settled and claims stop reading zero", () => {
    const events = decodeDeployEvents({ data: storedRows }, NAMES);
    const stats = computeStats(events);
    expect(stats.settled).toBe(1);
    expect(stats.claims).toBe(1);
    expect(stats.oracles).toBe(1);
    // No stake and no payout can be derived from these rows, and none is claimed.
    expect(stats.stakedMotes).toBe("0");
    expect(stats.paidOutMotes).toBe("0");
  });
});

describe("ordering", () => {
  it("sorts by block height, then deploy hash for a stable tie-break", () => {
    const events = sortEvents(decodeDeployEvents({ data: rows }));
    expect(events[0].blockHeight).toBeLessThan(events[1].blockHeight);
  });

  it("is a total order — equal heights never compare equal", () => {
    const base = decodeDeployEvent(BET)!;
    const sorted = sortEvents([
      { ...base, deployHash: "bbb" },
      { ...base, deployHash: "aaa" },
    ]);
    expect(sorted.map((e) => e.deployHash)).toEqual(["aaa", "bbb"]);
  });
});

describe("bareHash", () => {
  it("strips the hash- prefix the env map may or may not carry", () => {
    expect(bareHash("hash-abc")).toBe("abc");
    expect(bareHash("abc")).toBe("abc");
  });
});

describe("createDeployEvents — multiplexing", () => {
  function fetchStub() {
    return vi.fn(async (url: string) => {
      // Only the v1 package has anything; the point is that BOTH are read.
      const has = url.includes("v1package");
      return {
        ok: true,
        json: async () => ({ data: has ? [BET] : [] }),
      } as unknown as Response;
    });
  }

  it("reads EVERY routable contract, not just the vault", async () => {
    const fetchImpl = fetchStub();
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v1package", "hash-v2vault"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await port.fetch({ limit: 10 });
    const urls = fetchImpl.mock.calls.map((c) => c[0] as string);
    // The production defect: the vault was read and the five v1 packages were not.
    expect(urls.some((u) => u.includes("v1package"))).toBe(true);
    expect(urls.some((u) => u.includes("v2vault"))).toBe(true);
  });

  it("surfaces a v1 package's bets, which the vault-scoped stream could never see", async () => {
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v1package", "hash-v2vault"],
      fetchImpl: fetchStub() as unknown as typeof fetch,
    });
    const events = await port.fetch({ limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].marketId).toBe("cspr-mcap-1b-aug");
  });

  it("a failing contract read contributes nothing instead of blanking the board", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("bad")) throw new Error("network down");
      return { ok: true, json: async () => ({ data: [BET] }) } as unknown as Response;
    });
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-bad", "hash-good"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(port.fetch({ limit: 10 })).resolves.toHaveLength(1);
  });

  it("de-duplicates repeated contract hashes", async () => {
    const fetchImpl = fetchStub();
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v2vault", "v2vault", "hash-v2vault"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await port.fetch({ limit: 10 });
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it("keeps paginating through a page that is FULL but only partly decodable", async () => {
    // Production's actual failure: the vault's first page is 100 rows, of which 60 decoded. Ending
    // the walk on the decoded count made a full page look like the last one, so page two was never
    // requested — 54 bets and 175k CSPR staked reported against an actual 98 and 613k.
    const partlyDecodable = [
      ...Array.from({ length: 60 }, (_, i) => ({ ...BET, deploy_hash: `p1-${i}` })),
      ...Array.from({ length: 40 }, (_, i) => ({ ...REVERTED, deploy_hash: `p1-bad-${i}` })),
    ];
    const fetchImpl = vi.fn(async (url: string) => {
      const page = url.includes("page=2") ? [{ ...BET, deploy_hash: "p2-0" }] : partlyDecodable;
      return { ok: true, json: async () => ({ data: page }) } as unknown as Response;
    });
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v2vault"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const events = await port.fetch({ limit: 1_000 });
    expect(fetchImpl.mock.calls.some((c) => (c[0] as string).includes("page=2"))).toBe(true);
    expect(events).toHaveLength(61);
  });

  it("honours fromBlockHeight", async () => {
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v1package"],
      fetchImpl: fetchStub() as unknown as typeof fetch,
    });
    expect(await port.fetch({ fromBlockHeight: 9_999_999 })).toEqual([]);
  });
});

describe("createDeployEvents — resolving stored calls end to end", () => {
  /** Serves the two live payloads: a deploys page mixing both row shapes, and the entry-point table. */
  function chainStub() {
    return vi.fn(async (url: string) => {
      const body = url.includes("/entry-points")
        ? entryPointsPage
        : { data: [BET, RESOLVE, CLAIM, APPROVE_ORACLE] };
      return { ok: true, json: async () => body } as unknown as Response;
    });
  }

  it("folds the resolution and the claim the previous adapter could not see", async () => {
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v2vault"],
      fetchImpl: chainStub() as unknown as typeof fetch,
    });
    const events = await port.fetch({ limit: 100 });
    expect(events.map((e) => e.kind).sort()).toEqual([
      "bet_placed",
      "market_resolved",
      "payout_claimed",
    ]);
    expect(events.find((e) => e.kind === "market_resolved")?.outcomeKey).toBe("down");
  });

  it("asks for the entry-point table with an explicit page_size, or `resolve` is off the page", async () => {
    const fetchImpl = chainStub();
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v2vault"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await port.fetch({ limit: 100 });
    const url = fetchImpl.mock.calls
      .map((c) => c[0] as string)
      .find((u) => u.includes("/entry-points"))!;
    // The table is keyed by CONTRACT hash (the version that served the call), not the package.
    expect(url).toContain(`/contracts/${RESOLVE.contract_hash}/entry-points`);
    expect(url).toContain("page_size=100");
  });

  it("reads the table ONCE across folds and contracts — it is immutable per version", async () => {
    const fetchImpl = chainStub();
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-a", "hash-b"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await port.fetch({ limit: 100 });
    await port.fetch({ limit: 100 });
    const tableReads = fetchImpl.mock.calls.filter((c) => (c[0] as string).includes("/entry-points"));
    expect(tableReads).toHaveLength(1);
  });

  it("costs no extra request when a package has only proxied rows", async () => {
    const fetchImpl = vi.fn(
      async (_url: string) =>
        ({ ok: true, json: async () => ({ data: [BET, CREATE] }) }) as unknown as Response,
    );
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v1package"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await port.fetch({ limit: 100 });
    expect(fetchImpl.mock.calls.some((c) => (c[0] as string).includes("/entry-points"))).toBe(false);
  });

  it("retries a failed table read on the next fold instead of staying blind for good", async () => {
    let tableReads = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/entry-points")) {
        tableReads++;
        // Fail the first read only.
        if (tableReads === 1) return { ok: false, json: async () => ({}) } as unknown as Response;
        return { ok: true, json: async () => entryPointsPage } as unknown as Response;
      }
      return { ok: true, json: async () => ({ data: [RESOLVE] }) } as unknown as Response;
    });
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v2vault"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await port.fetch({ limit: 10 })).toEqual([]);
    const second = await port.fetch({ limit: 10 });
    expect(second).toHaveLength(1);
    expect(second[0].kind).toBe("market_resolved");
  });

  it("still drops a reverted resolution when reading through the port", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const body = url.includes("/entry-points")
        ? entryPointsPage
        : { data: [RESOLVE_REVERTED] };
      return { ok: true, json: async () => body } as unknown as Response;
    });
    const port = createDeployEvents("testnet", {
      contractHashes: ["hash-v2vault"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await port.fetch({ limit: 10 })).toEqual([]);
  });
});
