/**
 * The buildathon field — the data, the board math, and the routing guard that keeps a
 * 177-candidate market off a contract that can only hold eight outcomes.
 */

import { describe, it, expect } from "vitest";
import {
  BUILDATHON_FINALISTS,
  BUILDATHON_MARKET_SLUG,
  FIELD_MARKET_SLUGS,
  buidlUrl,
  findFinalist,
} from "@/core/buildathon-field";
import {
  WIDE_FIELD_THRESHOLD,
  backedCount,
  fieldRowFor,
  fieldRows,
  fieldSummary,
  isWideField,
  searchOutcomes,
} from "@/core/field-board";
import { buildMarket, findDefinition } from "@/core/catalogue";
import { categoryForResolver } from "@/core/market-category";
import { composeMarket } from "@/core/market-composer";
import { createMockLlm } from "@/adapters/mock/mock-llm";
import { resolveMarketTarget } from "@/adapters/casper/deploy-plan";
import type { Market } from "@/core/types";
import { createContainer } from "@/lib/container";
import { runProphetFleet } from "@/agent/prophet";
import { resolveMarket } from "@/agent/arbiter";
import { attestationFor } from "@/config/attestation";

const definition = findDefinition(BUILDATHON_MARKET_SLUG);

function market(pools: Record<string, string> = {}): Market {
  const base = buildMarket(definition!, "testnet");
  const poolByOutcomeMotes = { ...base.poolByOutcomeMotes, ...pools };
  const total = Object.values(poolByOutcomeMotes).reduce((a, v) => a + BigInt(v), 0n);
  return { ...base, poolByOutcomeMotes, totalStakedMotes: total.toString() };
}

describe("the finalist field", () => {
  it("carries all 177 announced finalists", () => {
    expect(BUILDATHON_FINALISTS).toHaveLength(177);
  });

  it("keys every candidate by a unique BUIDL id", () => {
    const ids = BUILDATHON_FINALISTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The reason the key is the id and not the name: five names on the announced list belong to two
   * different teams each. Keying by name would merge two teams' pools — and pay the wrong one.
   */
  it("contains duplicated project NAMES, which is why names are not keys", () => {
    const names = BUILDATHON_FINALISTS.map((f) => f.name);
    expect(new Set(names).size).toBeLessThan(names.length);
  });

  /** `MAX_CANDIDATE_LEN` in `field_market.rs` is 32; the ids must clear it with room. */
  it("keeps every key inside the contract's candidate-key bound", () => {
    for (const f of BUILDATHON_FINALISTS) {
      expect(f.id).toMatch(/^\d{4,8}$/);
      expect(f.name.trim()).toBe(f.name);
      expect(f.name.length).toBeGreaterThan(0);
    }
  });

  it("links a candidate back to its submission", () => {
    expect(buidlUrl("46696")).toBe("https://dorahacks.io/buidl/46696");
    expect(findFinalist("46696")?.name).toBe("Hunch");
    expect(findFinalist("00000")).toBeUndefined();
  });
});

describe("the market definition", () => {
  it("exists in the catalogue with one outcome per finalist", () => {
    expect(definition).toBeDefined();
    expect(definition!.outcomes).toHaveLength(177);
    expect(definition!.outcomes.map((o) => o.key)).toEqual(BUILDATHON_FINALISTS.map((f) => f.id));
  });

  /** The whole point of the ask: nothing is pre-staked, by anyone, anywhere on this board. */
  it("seeds nothing — every one of the 177 pools starts at zero", () => {
    const m = market();
    expect(m.totalStakedMotes).toBe("0");
    expect(Object.values(m.poolByOutcomeMotes).every((v) => v === "0")).toBe(true);
    expect(backedCount(m)).toBe(0);
  });

  it("resolves as an attested n-way winner and shelves as community", () => {
    expect(definition!.resolver.kind).toBe("nway_winner");
    expect(definition!.resolver.source).toBe("attested");
    expect(categoryForResolver(definition!.resolver)).toBe("community");
    expect(definition!.category).toBe("community");
  });

  it("locks betting at the announced deadline but may settle earlier", () => {
    expect(definition!.deadlineIso).toBe("2026-08-31T23:59:59.000Z");
    expect(definition!.cadence).toBe("one-shot");
  });

  /** An attested market settles on the Arbiter's word — the public cannot mint one. */
  it("refuses a public creation on the attested source", async () => {
    const res = await composeMarket(
      {
        claim: "Which project wins some other contest",
        creator: "creator-1",
        network: "testnet",
        seq: 0,
        deadlineIso: "2026-09-01T00:00:00.000Z",
        source: "attested",
        metric: "buildathon_grand_prize",
        method: "nway_winner",
        outcomes: [
          { key: "a", label: "A" },
          { key: "b", label: "B" },
        ],
      },
      { llm: createMockLlm(), existing: [] },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/attested/);
  });
});

describe("field search", () => {
  const outcomes = definition!.outcomes;

  it("finds a project by name, case- and accent-insensitively", () => {
    expect(searchOutcomes(outcomes, "hunch")[0]?.key).toBe("46696");
    expect(searchOutcomes(outcomes, "SASHA")[0]?.label).toContain("Sasha");
  });

  it("finds a project by its BUIDL id", () => {
    expect(searchOutcomes(outcomes, "46696")[0]?.key).toBe("46696");
    expect(searchOutcomes(outcomes, "466")[0]?.key.startsWith("466")).toBe(true);
  });

  it("matches a word inside a long name", () => {
    const hits = searchOutcomes(outcomes, "sequencer");
    expect(hits.map((o) => o.key)).toContain("44158");
  });

  /** Both teams called "Sluice" must survive the search — neither is shadowed by the other. */
  it("returns every team sharing a name", () => {
    const hits = searchOutcomes(outcomes, "sluice");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hits.map((o) => o.key)).size).toBe(hits.length);
  });

  it("returns the whole field for an empty query and nothing for a miss", () => {
    expect(searchOutcomes(outcomes, "   ")).toHaveLength(177);
    expect(searchOutcomes(outcomes, "zzzzznotathing")).toHaveLength(0);
  });

  it("ranks an exact id above a name that merely contains the text", () => {
    const hits = searchOutcomes(
      [
        { key: "12345", label: "Something" },
        { key: "99999", label: "Project 12345" },
      ],
      "12345",
    );
    expect(hits[0]?.key).toBe("12345");
  });
});

describe("field standings", () => {
  it("treats the market as a wide field", () => {
    expect(isWideField(market())).toBe(true);
    expect(WIDE_FIELD_THRESHOLD).toBeLessThan(177);
  });

  /** An unbet field has no leader: numbering it 1…177 would invent one out of list order. */
  it("ranks nothing while nothing is staked", () => {
    const rows = fieldRows(market());
    expect(rows).toHaveLength(177);
    expect(rows.every((r) => r.rank === null)).toBe(true);
    expect(rows.every((r) => r.impliedProbability === 0 && r.payoutMultiple === 0)).toBe(true);
  });

  it("ranks by stake, descending, once bets land", () => {
    const rows = fieldRows(market({ "46696": "3000000000", "46015": "7000000000" }));
    expect(rows[0]?.outcome.key).toBe("46015");
    expect(rows[0]?.rank).toBe(1);
    expect(rows[1]?.outcome.key).toBe("46696");
    expect(rows[1]?.rank).toBe(2);
    // Everything unbet shares the position after the two backed candidates.
    expect(rows[2]?.rank).toBe(3);
    expect(rows[176]?.rank).toBe(3);
  });

  it("derives implied probability from pool share", () => {
    const m = market({ "46696": "2500000000", "46015": "7500000000" });
    expect(fieldRowFor(m, "46696")!.impliedProbability).toBeCloseTo(0.25, 6);
    expect(fieldRowFor(m, "46015")!.impliedProbability).toBeCloseTo(0.75, 6);
    expect(backedCount(m)).toBe(2);
  });

  /** Fee-inclusive: the multiple on the board is what a winning stake actually pays. */
  it("prices the payout multiple net of the fee, off the losing pool only", () => {
    const m = market({ "46696": "2000000000", "46015": "8000000000" });
    // 8 CSPR losing, 2% fee = 0.16, distributable 7.84 over a 2 CSPR winning pool.
    expect(fieldRowFor(m, "46696")!.payoutMultiple).toBeCloseTo(1 + 7.84 / 2, 6);
  });

  it("has no row for a key outside the field", () => {
    expect(fieldRowFor(market(), "00000")).toBeUndefined();
  });
});

/**
 * The board card. One 177-row card in a three-column grid stretched its whole row and pushed the
 * neighbouring markets off the screen, so the card summarises the field instead of listing it.
 */
describe("field card summary", () => {
  it("shows no leaders while nothing is staked — the whole field is the tail", () => {
    const s = fieldSummary(market(), 3);
    expect(s.staked).toBe(false);
    expect(s.leaders).toEqual([]);
    expect(s.candidates).toBe(177);
    expect(s.backed).toBe(0);
    expect(s.rest).toBe(177);
  });

  it("caps the podium at the limit and counts the rest", () => {
    const s = fieldSummary(
      market({ "46696": "3000000000", "46015": "7000000000", "44012": "1000000000" }),
      3,
    );
    expect(s.leaders.map((r) => r.outcome.key)).toEqual(["46015", "46696", "44012"]);
    expect(s.leaders.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(s.leaders[0]!.impliedProbability).toBeCloseTo(7 / 11, 6);
    expect(s.backed).toBe(3);
    expect(s.rest).toBe(174);
  });

  /**
   * The one-backed case, which is what the live board actually looked like after its first bet:
   * one candidate at 100% and four joint-second rows at 0% is not a standing, it is padding.
   */
  it("shows only candidates someone backed, however big the limit", () => {
    const s = fieldSummary(market({ "46696": "1000000000" }), 5);
    expect(s.leaders.map((r) => r.outcome.key)).toEqual(["46696"]);
    expect(s.backed).toBe(1);
    expect(s.rest).toBe(176);
  });

  it("never shows more leaders than the field holds", () => {
    const pools = Object.fromEntries(
      definition!.outcomes.map((o, i) => [o.key, String((i + 1) * 1_000_000)]),
    );
    const s = fieldSummary(market(pools), 500);
    expect(s.leaders).toHaveLength(177);
    expect(s.rest).toBe(0);
  });
});

describe("contract routing", () => {
  it("pins the buildathon market to its FieldMarket package", () => {
    const target = resolveMarketTarget(`testnet:${BUILDATHON_MARKET_SLUG}`, {
      fieldMarket: `hash-${"a".repeat(64)}`,
      fieldMarketSlugs: FIELD_MARKET_SLUGS,
      vaultV2: `hash-${"b".repeat(64)}`,
    });
    expect(target.contract).toBe(`hash-${"a".repeat(64)}`);
    // No `market_id` arg: the FieldMarket ABI is the per-market one, `bet(outcome)`.
    expect(target.vaultMarketId).toBeUndefined();
  });

  /**
   * The money bug this guard exists to prevent: falling through to the vault would submit a real
   * stake at a market the vault cannot hold (8-outcome cap), so it must refuse rather than route.
   */
  it("refuses to fall back to the vault when the FieldMarket address is unset", () => {
    expect(() =>
      resolveMarketTarget(`testnet:${BUILDATHON_MARKET_SLUG}`, {
        vaultV2: `hash-${"b".repeat(64)}`,
        fieldMarketSlugs: FIELD_MARKET_SLUGS,
      }),
    ).toThrow(/FIELD_MARKET/);
  });

  it("leaves every other market's routing untouched", () => {
    const target = resolveMarketTarget("testnet:cspr-price-05-aug", {
      fieldMarket: `hash-${"a".repeat(64)}`,
      fieldMarketSlugs: FIELD_MARKET_SLUGS,
      vaultV2: `hash-${"b".repeat(64)}`,
    });
    expect(target.contract).toBe(`hash-${"b".repeat(64)}`);
    expect(target.vaultMarketId).toBe("cspr-price-05-aug");
  });
});

describe("the fleet and the Arbiter leave this market alone", () => {
  /**
   * "No default bets" has to survive the autonomous half of the app: a Prophet's stake comes out
   * of the operator's purse, so a fleet that traded the community board would be house money on a
   * board advertised as having none.
   */
  it("excludes the community board from the Prophet fleet", async () => {
    const container = createContainer("testnet");
    await container.store.list({ network: "testnet", status: "open" });
    const before = await container.store.get(BUILDATHON_MARKET_SLUG, "testnet");
    expect(before?.totalStakedMotes).toBe("0");

    // Enough rounds that the round-robin target selection would have reached a 20-market board
    // several times over.
    for (let seq = 0; seq < 60; seq++) {
      await runProphetFleet(container, seq, { maxProphets: 1 });
    }

    const after = await container.store.get(BUILDATHON_MARKET_SLUG, "testnet");
    expect(after?.totalStakedMotes).toBe("0");
  });

  /**
   * The mock oracle answers ANY market id with a deterministic pseudo-random outcome. Letting the
   * sweep use it here would declare the winner of a real contest by hashing a string.
   */
  it("refuses to auto-resolve without an attestation", async () => {
    delete process.env.MARKET_ATTESTATIONS;
    const container = createContainer("testnet");
    const action = await resolveMarket(container, BUILDATHON_MARKET_SLUG);
    expect(action).toBeNull();
    expect(await container.store.settlementFor(`testnet:${BUILDATHON_MARKET_SLUG}`)).toBeFalsy();
  });

  it("reads the winner from the operator's attestation when there is one", async () => {
    process.env.MARKET_ATTESTATIONS = JSON.stringify({
      [BUILDATHON_MARKET_SLUG]: {
        winningOutcomeKey: "46696",
        evidenceUrl: "https://dorahacks.io/hackathon/results",
      },
    });
    expect(attestationFor(BUILDATHON_MARKET_SLUG)?.winningOutcomeKey).toBe("46696");
    delete process.env.MARKET_ATTESTATIONS;
  });

  it("ignores a malformed or unknown-key attestation rather than settling on it", () => {
    process.env.MARKET_ATTESTATIONS = "{not json";
    expect(attestationFor(BUILDATHON_MARKET_SLUG)).toBeUndefined();
    process.env.MARKET_ATTESTATIONS = JSON.stringify({ [BUILDATHON_MARKET_SLUG]: { winningOutcomeKey: "" } });
    expect(attestationFor(BUILDATHON_MARKET_SLUG)).toBeUndefined();
    delete process.env.MARKET_ATTESTATIONS;
  });

  /** A void attestation is legitimate: co-winners with no single first place refunds everyone. */
  it("accepts a null winner as a void instruction", () => {
    process.env.MARKET_ATTESTATIONS = JSON.stringify({
      [BUILDATHON_MARKET_SLUG]: { winningOutcomeKey: null, note: "co-winners" },
    });
    expect(attestationFor(BUILDATHON_MARKET_SLUG)).toEqual({
      winningOutcomeKey: null,
      evidenceUrl: undefined,
      evidenceHash: undefined,
      note: "co-winners",
    });
    delete process.env.MARKET_ATTESTATIONS;
  });
});
