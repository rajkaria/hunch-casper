import { describe, it, expect, afterEach } from "vitest";
import {
  rampedCapCspr,
  currentMaxBetCspr,
  bannerDisclosure,
  auditStatusFromEnv,
  mainnetAgeDays,
  UNAUDITED_MAINNET_CAP_CSPR,
  type AuditStatus,
} from "@/config/caps";
import { maxBetCspr, exceedsBetCap } from "@/config/network";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

const STATUSES: AuditStatus[] = ["unaudited", "in-progress", "audited"];
const AGES = [0, 1, 15, 29, 30, 60, 89, 90, 180, 365, 100000];

describe("cap-ramp invariant — audit gates every raise", () => {
  it("NO cap exceeds the unaudited ceiling unless the status is 'audited'", () => {
    for (const status of STATUSES) {
      for (const age of AGES) {
        const cap = rampedCapCspr(status, age);
        if (cap === null || cap > UNAUDITED_MAINNET_CAP_CSPR) {
          expect(status, `status=${status} age=${age} produced cap=${cap}`).toBe("audited");
        }
      }
    }
  });

  it("unaudited + in-progress are pinned to the ceiling at every age", () => {
    for (const status of ["unaudited", "in-progress"] as AuditStatus[]) {
      for (const age of AGES) {
        expect(rampedCapCspr(status, age)).toBe(UNAUDITED_MAINNET_CAP_CSPR);
      }
    }
  });

  it("the audited track is monotonic non-decreasing in age (null = uncapped = highest)", () => {
    let prev = -1;
    for (const age of [...AGES].sort((a, b) => a - b)) {
      const cap = rampedCapCspr("audited", age);
      const rank = cap === null ? Infinity : cap;
      expect(rank).toBeGreaterThanOrEqual(prev);
      prev = rank;
    }
  });

  it("negative / non-finite ages are treated as day zero, never as an unlock", () => {
    expect(rampedCapCspr("audited", -5)).toBe(rampedCapCspr("audited", 0));
    expect(rampedCapCspr("audited", NaN)).toBe(rampedCapCspr("audited", 0));
  });
});

describe("current cap wiring", () => {
  it("defaults (no env) preserve the historical behaviour exactly", () => {
    delete process.env.NEXT_PUBLIC_AUDIT_STATUS;
    expect(currentMaxBetCspr("testnet")).toBeNull();
    expect(currentMaxBetCspr("mainnet")).toBe(UNAUDITED_MAINNET_CAP_CSPR);
    expect(maxBetCspr("mainnet")).toBe(UNAUDITED_MAINNET_CAP_CSPR);
    expect(exceedsBetCap("mainnet", UNAUDITED_MAINNET_CAP_CSPR)).toBe(false);
    expect(exceedsBetCap("mainnet", UNAUDITED_MAINNET_CAP_CSPR + 0.01)).toBe(true);
    expect(exceedsBetCap("testnet", 1e6)).toBe(false);
  });

  it("audited status lifts the cap (and the ramp with age)", () => {
    process.env.NEXT_PUBLIC_AUDIT_STATUS = "audited";
    process.env.NEXT_PUBLIC_MAINNET_LAUNCH_ISO = "2026-07-01T00:00:00.000Z";
    // 5 days in → first audited stage.
    const now = Date.parse("2026-07-06T00:00:00.000Z");
    expect(currentMaxBetCspr("mainnet", now)).toBe(100);
    // 120 days in → uncapped.
    const later = Date.parse("2026-11-01T00:00:00.000Z");
    expect(currentMaxBetCspr("mainnet", later)).toBeNull();
  });

  it("reads audit status safely, defaulting unknowns to unaudited", () => {
    process.env.NEXT_PUBLIC_AUDIT_STATUS = "totally-audited-trust-me";
    expect(auditStatusFromEnv()).toBe("unaudited");
    process.env.NEXT_PUBLIC_AUDIT_STATUS = "in-progress";
    expect(auditStatusFromEnv()).toBe("in-progress");
  });

  it("treats a missing or future launch date as age zero", () => {
    delete process.env.NEXT_PUBLIC_MAINNET_LAUNCH_ISO;
    expect(mainnetAgeDays()).toBe(0);
    process.env.NEXT_PUBLIC_MAINNET_LAUNCH_ISO = "2999-01-01T00:00:00.000Z";
    expect(mainnetAgeDays(Date.parse("2026-07-19T00:00:00.000Z"))).toBe(0);
  });
});

describe("banner disclosure matches the cap", () => {
  it("shows on unaudited mainnet, hidden on testnet, hidden once audited", () => {
    delete process.env.NEXT_PUBLIC_AUDIT_STATUS;
    expect(bannerDisclosure("mainnet").show).toBe(true);
    expect(bannerDisclosure("mainnet").capCspr).toBe(UNAUDITED_MAINNET_CAP_CSPR);
    expect(bannerDisclosure("testnet").show).toBe(false);

    process.env.NEXT_PUBLIC_AUDIT_STATUS = "audited";
    expect(bannerDisclosure("mainnet").show).toBe(false);
  });
});
