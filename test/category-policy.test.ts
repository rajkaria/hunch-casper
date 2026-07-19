import { describe, it, expect } from "vitest";
import { assessMarket, assessMarketFields } from "@/core/category-policy";
import { MARKET_DEFINITIONS } from "@/core/catalogue";

describe("category policy — rejects the prohibited set", () => {
  const banned: Array<[string, string]> = [
    ["Will the president be assassinated this year?", "violence-or-death"],
    ["Will there be a mass shooting at the summit?", "violence-or-death"],
    ["Will [public figure] die before 2027?", "harm-to-person"],
    ["Will the CEO survive the year?", "harm-to-person"],
    ["Will this token rugpull by Friday?", "manipulation-prone"],
    ["Is this a pump and dump?", "manipulation-prone"],
    ["Will they hire a hitman?", "illegal-activity"],
    ["Should this group be deported?", "hateful-or-abusive"],
  ];

  it.each(banned)("rejects %s", (text, reason) => {
    const v = assessMarket(text);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe(reason);
    expect(v.message).toBeTruthy();
  });
});

describe("category policy — accepts legitimate markets", () => {
  const allowed = [
    "CSPR above $0.05 by Aug 1?",
    "CSPR up or down this hour?",
    "Casper daily deploys above 30k?",
    "Will BTC hit $150k by August?",
    "Coin flip: HEADS, TAILS or TIE?",
    "Will CSPR staking APY hold above 11%?",
    // near-miss substrings that must NOT trip word-boundary rules
    "Will the deadline for the upgrade slip past Q3?",
    "Which team wins in sudden-death overtime?",
    "Will the war-chest proposal pass governance?", // 'war' inside 'war-chest'
    "Will this skill ship this sprint?", // 'kill' inside 'skill'
  ];

  it.each(allowed)("allows %s", (text) => {
    expect(assessMarket(text).allowed).toBe(true);
  });

  it("accepts every market in the shipped catalogue", () => {
    for (const def of MARKET_DEFINITIONS) {
      const v = assessMarketFields({ title: def.title, subtitle: def.subtitle, description: def.resolver.description });
      expect(v.allowed, `catalogue market rejected: ${def.title} (${v.reason})`).toBe(true);
    }
  });
});

describe("assessMarketFields joins all fields", () => {
  it("trips on a banned term hiding in the description", () => {
    const v = assessMarketFields({
      title: "A perfectly normal market",
      description: "resolves yes if the pump and dump completes",
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("manipulation-prone");
  });
});
