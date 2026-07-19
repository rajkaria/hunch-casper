import { describe, it, expect } from "vitest";
import { claimMention, finalizeMention, releaseMention, type MentionRecord } from "@/lib/bot-idempotency";

function ledger() {
  return new Map<string, MentionRecord>();
}

describe("mention idempotency guard", () => {
  it("the first claim wins; a second sees a pending marker", () => {
    const l = ledger();
    const first = claimMention("x:1", 100, l);
    expect(first.fresh).toBe(true);
    const second = claimMention("x:1", 101, l);
    expect(second.fresh).toBe(false);
    if (!second.fresh) expect(second.record.status).toBe("pending");
  });

  it("finalize records the reply, replayed to later claims", () => {
    const l = ledger();
    claimMention("x:1", 100, l);
    finalizeMention("x:1", { reply: "done", deployHash: "abc" }, l);
    const again = claimMention("x:1", 200, l);
    expect(again.fresh).toBe(false);
    if (!again.fresh) {
      expect(again.record.status).toBe("done");
      expect(again.record.reply).toBe("done");
      expect(again.record.deployHash).toBe("abc");
    }
  });

  it("release lets a fresh claim succeed again (pre-bet failure path)", () => {
    const l = ledger();
    claimMention("x:1", 100, l);
    releaseMention("x:1", l);
    const retry = claimMention("x:1", 300, l);
    expect(retry.fresh).toBe(true);
  });

  it("preserves the original claim time across finalize", () => {
    const l = ledger();
    claimMention("x:1", 100, l);
    finalizeMention("x:1", { reply: "r" }, l);
    expect(l.get("x:1")!.claimedAtMs).toBe(100);
  });
});
