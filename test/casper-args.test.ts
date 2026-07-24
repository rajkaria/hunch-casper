/**
 * Fixtures are VERBATIM live CSPR.cloud payloads (testnet, vault v2 package
 * ce451360…, captured 2026-07-24), not invented shapes. AGENTS.md requires it: the
 * `/auction-metrics` bug lived undetected precisely because a test asserted against a fabricated
 * response, so a green gate proved nothing about the real endpoint.
 */

import { describe, expect, it } from "vitest";
import {
  decodeNamedArgs,
  argString,
  argNumber,
  argStringList,
  argAccountHex,
} from "@/core/casper-args";

/** Live `bet` call: market_id="cspr-mcap-1b-aug", outcome="yes". */
const BET_ARGS = [
  2, 0, 0, 0, 9, 0, 0, 0, 109, 97, 114, 107, 101, 116, 95, 105, 100, 20, 0, 0, 0, 16, 0, 0, 0, 99,
  115, 112, 114, 45, 109, 99, 97, 112, 45, 49, 98, 45, 97, 117, 103, 10, 7, 0, 0, 0, 111, 117, 116,
  99, 111, 109, 101, 7, 0, 0, 0, 3, 0, 0, 0, 121, 101, 115, 10,
];

/** Live `create_market` call — seven args including a Key oracle, U32 fee, U64 deadline, List. */
const CREATE_ARGS = [
  7, 0, 0, 0, 9, 0, 0, 0, 109, 97, 114, 107, 101, 116, 95, 105, 100, 59, 0, 0, 0, 55, 0, 0, 0, 117,
  115, 101, 114, 45, 99, 115, 112, 114, 45, 116, 114, 97, 100, 101, 115, 45, 97, 98, 111, 118, 101,
  45, 48, 45, 48, 48, 49, 45, 97, 116, 45, 116, 104, 101, 45, 106, 117, 108, 121, 45, 50, 48, 45,
  114, 101, 115, 111, 108, 118, 101, 45, 112, 45, 49, 10, 8, 0, 0, 0, 113, 117, 101, 115, 116, 105,
  111, 110, 68, 0, 0, 0, 64, 0, 0, 0, 67, 83, 80, 82, 32, 116, 114, 97, 100, 101, 115, 32, 97, 98,
  111, 118, 101, 32, 36, 48, 46, 48, 48, 49, 32, 97, 116, 32, 116, 104, 101, 32, 74, 117, 108, 121,
  32, 50, 48, 32, 114, 101, 115, 111, 108, 118, 101, 45, 112, 97, 116, 104, 32, 99, 104, 101, 99,
  107, 112, 111, 105, 110, 116, 63, 10, 8, 0, 0, 0, 99, 97, 116, 101, 103, 111, 114, 121, 17, 0, 0,
  0, 13, 0, 0, 0, 112, 114, 111, 118, 97, 98, 108, 121, 45, 102, 97, 105, 114, 10, 6, 0, 0, 0, 111,
  114, 97, 99, 108, 101, 33, 0, 0, 0, 0, 83, 46, 180, 244, 98, 119, 20, 48, 37, 243, 187, 220, 25,
  107, 154, 245, 67, 224, 180, 164, 241, 173, 126, 107, 110, 81, 156, 247, 137, 142, 177, 206, 11,
  7, 0, 0, 0, 102, 101, 101, 95, 98, 112, 115, 4, 0, 0, 0, 200, 0, 0, 0, 4, 8, 0, 0, 0, 100, 101,
  97, 100, 108, 105, 110, 101, 8, 0, 0, 0, 112, 126, 16, 126, 159, 1, 0, 0, 5, 8, 0, 0, 0, 111, 117,
  116, 99, 111, 109, 101, 115, 17, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 121, 101, 115, 2, 0, 0, 0, 110,
  111, 14, 10,
];

describe("decodeNamedArgs — live vault payloads", () => {
  it("decodes a real bet's market and outcome", () => {
    const args = decodeNamedArgs(BET_ARGS);
    expect(args.map((a) => a.name)).toEqual(["market_id", "outcome"]);
    expect(argString(args, "market_id")).toBe("cspr-mcap-1b-aug");
    expect(argString(args, "outcome")).toBe("yes");
  });

  it("decodes all seven args of a real create_market", () => {
    const args = decodeNamedArgs(CREATE_ARGS);
    expect(args.map((a) => a.name)).toEqual([
      "market_id",
      "question",
      "category",
      "oracle",
      "fee_bps",
      "deadline",
      "outcomes",
    ]);
    expect(argString(args, "market_id")).toBe(
      "user-cspr-trades-above-0-001-at-the-july-20-resolve-p-1",
    );
    expect(argString(args, "category")).toBe("provably-fair");
    expect(argNumber(args, "fee_bps")).toBe("200");
    expect(argStringList(args, "outcomes")).toEqual(["yes", "no"]);
  });

  it("decodes the U64 deadline as an epoch-ms string", () => {
    const args = decodeNamedArgs(CREATE_ARGS);
    const deadline = argNumber(args, "deadline");
    expect(deadline).toBeDefined();
    // Sanity: a real deadline, not a byte-order accident.
    expect(Number(deadline)).toBeGreaterThan(Date.parse("2026-01-01"));
    expect(Number(deadline)).toBeLessThan(Date.parse("2027-01-01"));
  });

  it("decodes the oracle Key as the deployer account hash", () => {
    const args = decodeNamedArgs(CREATE_ARGS);
    // The approved Arbiter/deployer oracle — account-hash-532eb4f4… in the deploy runbook.
    expect(argAccountHex(args, "oracle")).toBe(
      "532eb4f46277143025f3bbdc196b9af543e0b4a4f1ad7e6b6e519cf7898eb1ce",
    );
  });

  it("returns undefined for an absent arg rather than guessing", () => {
    const args = decodeNamedArgs(BET_ARGS);
    expect(argString(args, "winning_outcome")).toBeUndefined();
    expect(argNumber(args, "nope")).toBeUndefined();
    expect(argStringList(args, "nope")).toBeUndefined();
  });

  it("refuses to read a value as the wrong type", () => {
    const args = decodeNamedArgs(CREATE_ARGS);
    expect(argString(args, "fee_bps")).toBeUndefined(); // U32, not String
    expect(argNumber(args, "market_id")).toBeUndefined(); // String, not a number
  });

  it("survives a truncated blob without throwing", () => {
    expect(() => decodeNamedArgs(BET_ARGS.slice(0, 20))).not.toThrow();
    expect(decodeNamedArgs([])).toEqual([]);
    expect(decodeNamedArgs([255, 255, 255, 255])).toEqual([]);
  });
});
