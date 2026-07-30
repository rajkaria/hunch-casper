/**
 * The bet panel's stake parsing.
 *
 * The crash it pins: "1e300" passed the old validity check (`> 0 && isFinite`), then
 * `csprToMotes(1e300)` rounded to `Infinity` and `BigInt(Infinity)` threw a RangeError out of the
 * payout preview — a page crash from a text field. Validity now means "an amount a wallet could
 * conceivably fund", and anything else never reaches the motes math.
 */

import { describe, it, expect } from "vitest";
import { MAX_STAKE_CSPR, parseStakeCspr } from "@/components/bet-panel";
import { csprToMotes } from "@/core/types";

describe("parseStakeCspr", () => {
  it("accepts ordinary stakes", () => {
    expect(parseStakeCspr("1")).toBe(1);
    expect(parseStakeCspr("0.5")).toBe(0.5);
    expect(parseStakeCspr("2500")).toBe(2500);
    expect(parseStakeCspr(String(MAX_STAKE_CSPR))).toBe(MAX_STAKE_CSPR);
  });

  it("rejects the 1e300 crash input — and everything the motes math cannot hold", () => {
    for (const raw of ["1e300", "1e100", String(MAX_STAKE_CSPR + 1), "Infinity"]) {
      expect(parseStakeCspr(raw)).toBeNull();
    }
  });

  it("rejects non-positive and non-numeric input", () => {
    for (const raw of ["0", "-1", "NaN", "abc", "", " "]) {
      expect(parseStakeCspr(raw)).toBeNull();
    }
  });

  it("every accepted stake survives csprToMotes without throwing", () => {
    for (const raw of ["0.000000001", "1", "123.456", String(MAX_STAKE_CSPR)]) {
      const parsed = parseStakeCspr(raw);
      expect(parsed).not.toBeNull();
      expect(() => csprToMotes(parsed!)).not.toThrow();
    }
  });
});
