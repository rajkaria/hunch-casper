import { describe, it, expect, beforeEach } from "vitest";
import { planMirror, splitCopyFee, type FollowConfig, type AgentPosition } from "@/core/copy-betting";
import { createContainer } from "@/lib/container";
import { placeMirror, fanOutPosition, setFollow, __resetFollows } from "@/lib/copy-betting";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import type { MarketCategory } from "@/core/types";

beforeEach(() => {
  __resetLedger();
  __resetConsumedNonces();
  __resetFollows();
});

function follow(over: Partial<FollowConfig> = {}): FollowConfig {
  return { follower: "f1", agentId: "agent:momentum", scaleBps: 5000, perBetCapMotes: "10000000000", active: true, ...over };
}
function position(over: Partial<AgentPosition> = {}): AgentPosition {
  return { marketId: "testnet:cspr-price-05-aug", category: "casper-native", outcomeKey: "yes", agentStakeMotes: "4000000000", ...over };
}

describe("planMirror — sizing + guardrails", () => {
  it("mirrors sized by scale, clamped to the per-bet cap", () => {
    const p = planMirror(follow({ scaleBps: 5000 }), position({ agentStakeMotes: "4000000000" }), true);
    expect(p.mirror).toBe(true);
    if (p.mirror) expect(p.amountMotes).toBe("2000000000"); // 50% of 4 CSPR
    // Cap bites: agent stakes 100 CSPR, cap 10 CSPR.
    const capped = planMirror(follow({ scaleBps: 10000, perBetCapMotes: "10000000000" }), position({ agentStakeMotes: "100000000000" }), true);
    if (capped.mirror) expect(capped.amountMotes).toBe("10000000000");
  });

  it("a meta-market mirror is PROVABLY impossible", () => {
    const metaCats: MarketCategory[] = ["meta"];
    for (const category of metaCats) {
      const p = planMirror(follow(), position({ category }), true);
      expect(p.mirror).toBe(false);
      if (!p.mirror) expect(p.reason).toBe("meta-excluded");
    }
  });

  it("unwinds on inactive follow or deactivated agent", () => {
    expect(planMirror(follow({ active: false }), position(), true)).toMatchObject({ mirror: false, reason: "inactive" });
    expect(planMirror(follow(), position(), false)).toMatchObject({ mirror: false, reason: "agent-deactivated" });
  });

  it("refuses a zero-size position or a cap that clamps to zero", () => {
    expect(planMirror(follow(), position({ agentStakeMotes: "0" }), true)).toMatchObject({ mirror: false, reason: "zero-size" });
    expect(planMirror(follow({ perBetCapMotes: "0" }), position(), true)).toMatchObject({ mirror: false, reason: "capped-to-zero" });
  });
});

describe("splitCopyFee — conservation (agent + platform == fee)", () => {
  it("splits by the agent share, dust to the platform", () => {
    const s = splitCopyFee("1000000", 200, 6000); // 2% fee, agent 60%
    expect(s.feeMotes).toBe("20000"); // 2% of 1,000,000
    expect(s.agentMotes).toBe("12000"); // 60%
    expect(s.platformMotes).toBe("8000"); // 40%
    expect(BigInt(s.agentMotes) + BigInt(s.platformMotes)).toBe(BigInt(s.feeMotes));
  });

  it("conserves across a grid of volumes/fees/shares (dust never overpays the agent)", () => {
    for (const vol of ["1", "7", "100", "999999", "123456789"]) {
      for (const feeBps of [50, 200, 333, 900]) {
        for (const shareBps of [0, 3333, 5000, 6667, 10000]) {
          const s = splitCopyFee(vol, feeBps, shareBps);
          expect(BigInt(s.agentMotes) + BigInt(s.platformMotes)).toBe(BigInt(s.feeMotes));
          // Agent is never paid more than its exact share (floored).
          const expectedAgent = (BigInt(s.feeMotes) * BigInt(shareBps)) / 10000n;
          expect(BigInt(s.agentMotes)).toBe(expectedAgent);
        }
      }
    }
  });

  it("rejects out-of-range parameters", () => {
    expect(() => splitCopyFee("100", 10000, 5000)).toThrow();
    expect(() => splitCopyFee("100", 200, 10001)).toThrow();
  });
});

describe("mirror settles through the full money path", () => {
  it("places a mirrored bet through x402 and moves the pool", async () => {
    const container = createContainer("testnet");
    const before = await container.store.get("cspr-price-05-aug", "testnet");
    const poolBefore = BigInt(before!.poolByOutcomeMotes.yes);

    const res = await placeMirror(container, follow(), position({ agentStakeMotes: "4000000000" }), true);
    expect(res.plan.mirror).toBe(true);
    expect(res.placed).toBeDefined();
    expect(res.placed!.amountMotes).toBe("2000000000");

    const after = await container.store.get("cspr-price-05-aug", "testnet");
    expect(BigInt(after!.poolByOutcomeMotes.yes)).toBe(poolBefore + 2000000000n);
  });

  it("fans a position out to all active followers, skipping meta and inactive", async () => {
    const container = createContainer("testnet");
    setFollow(follow({ follower: "f1", scaleBps: 2500 }));
    setFollow(follow({ follower: "f2", scaleBps: 5000 }));
    setFollow(follow({ follower: "f3", active: false }));

    const results = await fanOutPosition(container, "agent:momentum", position({ agentStakeMotes: "4000000000" }));
    // f1 + f2 mirror (f3 inactive is filtered out of followersOf).
    const placed = results.filter((r) => r.placed);
    expect(placed).toHaveLength(2);

    // A meta position mirrors for nobody.
    const metaResults = await fanOutPosition(container, "agent:momentum", position({ category: "meta", marketId: "testnet:prophet-race-weekly" }));
    expect(metaResults.every((r) => !r.plan.mirror)).toBe(true);
  });
});
