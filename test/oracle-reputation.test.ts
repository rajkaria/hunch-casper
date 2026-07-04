import { describe, it, expect, beforeEach } from "vitest";
import { accuracyBps, recordResolution } from "@/core/oracle-reputation";
import type { OracleReputationState } from "@/core/oracle-reputation";
import {
  oracleRecordResolution,
  oracleReputationOf,
  __resetOracleLedger,
} from "@/adapters/mock/oracle-ledger";
import { GET as oracleGET } from "@/app/api/oracle/[id]/route";

beforeEach(__resetOracleLedger);

describe("oracle-reputation core (mirrors the on-chain accuracy_bps)", () => {
  it("computes floored accuracy in basis points", () => {
    expect(accuracyBps(123, 128)).toBe(9609); // 96.09%
    expect(accuracyBps(3, 4)).toBe(7500);
    expect(accuracyBps(1, 3)).toBe(3333); // floored
    expect(accuracyBps(0, 0)).toBe(0);
  });

  it("folds a resolution into the state", () => {
    const s: OracleReputationState = { oracleId: "x", name: "X", resolved: 2, accurate: 1 };
    expect(recordResolution(s, true)).toEqual({ oracleId: "x", name: "X", resolved: 3, accurate: 2 });
    expect(recordResolution(s, false)).toEqual({ oracleId: "x", name: "X", resolved: 3, accurate: 1 });
  });
});

describe("oracle-reputation ledger", () => {
  it("seeds the Arbiter with a prior track record", () => {
    const rep = oracleReputationOf("arbiter");
    expect(rep.name).toBe("Arbiter");
    expect(rep.resolved).toBe(128);
    expect(rep.accurate).toBe(123);
    expect(accuracyBps(rep.accurate, rep.resolved)).toBe(9609);
  });

  it("folds new resolutions in and is idempotent per market", () => {
    const a = oracleRecordResolution("arbiter", "m1", true);
    expect(a.resolved).toBe(129);
    expect(a.accurate).toBe(124);
    // Same market again → no double count.
    const b = oracleRecordResolution("arbiter", "m1", true);
    expect(b.resolved).toBe(129);
    // A different market does count.
    const c = oracleRecordResolution("arbiter", "m2", false);
    expect(c.resolved).toBe(130);
    expect(c.accurate).toBe(124);
  });
});

describe("GET /api/oracle/[id]", () => {
  it("returns the oracle's reputation", async () => {
    const res = await oracleGET(new Request("http://localhost/api/oracle/arbiter"), {
      params: Promise.resolve({ id: "arbiter" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.reputation.name).toBe("Arbiter");
    expect(json.reputation.accuracyBps).toBe(9609);
    expect(json.reputation.resolvedCount).toBe(128);
    expect(json.reputation.accuracy).toBeCloseTo(0.9609, 4);
  });
});
