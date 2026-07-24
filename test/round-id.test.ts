import { describe, expect, it } from "vitest";
import { roundMarketId, parseRoundMarketId, baseSlug } from "@/core/round-id";

describe("round market ids", () => {
  it("encodes a round as <slug>#<index>", () => {
    expect(roundMarketId("cspr-hourly-updown", 7)).toBe("cspr-hourly-updown#7");
  });

  it("round-trips", () => {
    const id = roundMarketId("coin-flip-5m", 1234);
    expect(parseRoundMarketId(id)).toEqual({ slug: "coin-flip-5m", roundIndex: 1234 });
  });

  it("treats a plain slug as round-less", () => {
    expect(parseRoundMarketId("btc-150k-aug")).toEqual({ slug: "btc-150k-aug", roundIndex: null });
  });

  it("baseSlug strips the round from either form", () => {
    expect(baseSlug("cspr-hourly-updown#7")).toBe("cspr-hourly-updown");
    expect(baseSlug("btc-150k-aug")).toBe("btc-150k-aug");
  });

  it("rejects a negative or non-integer round index", () => {
    expect(() => roundMarketId("x", -1)).toThrow(/round index/i);
    expect(() => roundMarketId("x", 1.5)).toThrow(/round index/i);
  });

  it("a malformed suffix is round-less, not a crash", () => {
    expect(parseRoundMarketId("x#nope")).toEqual({ slug: "x#nope", roundIndex: null });
  });
});
