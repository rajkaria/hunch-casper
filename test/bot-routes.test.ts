import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST as telegramPOST } from "@/app/api/bots/telegram/route";
import { POST as xPOST, GET as xGET } from "@/app/api/bots/x/route";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { __resetMentionLedger } from "@/lib/bot-idempotency";
import { RECORDED_REPLIES, __resetRecordedReplies } from "@/adapters/bots/webhook-transport";

const savedEnv = { ...process.env };
beforeEach(() => {
  __resetLedger();
  __resetConsumedNonces();
  __resetMentionLedger();
  __resetRecordedReplies();
  delete process.env.HUNCH_BOTS_LIVE; // dry-run: replies are recorded, never posted
});
afterEach(() => {
  process.env = { ...savedEnv };
});

const SLUG = "cspr-price-05-aug";

function tgPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return telegramPOST(
    new Request("http://localhost/api/bots/telegram", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function tgUpdate(text: string, updateId = 1) {
  return { update_id: updateId, message: { message_id: updateId, from: { id: 777 }, chat: { id: 555 }, text } };
}

describe("POST /api/bots/telegram", () => {
  it("places a bet from a webhook update and records the reply in dry-run", async () => {
    const res = await tgPost(tgUpdate(`@hunchbot bet 5 CSPR YES on ${SLUG}`, 100));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.placed).toBe(true);
    expect(RECORDED_REPLIES).toHaveLength(1);
    expect(RECORDED_REPLIES[0].live).toBe(false);
    expect(RECORDED_REPLIES[0].text).toContain("Bet placed");
  });

  it("is idempotent on a retried update_id — one bet, replay reply", async () => {
    await tgPost(tgUpdate(`bet 5 YES on ${SLUG}`, 200));
    const before = RECORDED_REPLIES.length;
    const res = await tgPost(tgUpdate(`bet 5 YES on ${SLUG}`, 200));
    const json = await res.json();
    expect(json.replayed).toBe(true);
    expect(json.placed).toBe(false);
    // one more recorded reply (the replay), and the pool only moved once.
    expect(RECORDED_REPLIES.length).toBe(before + 1);
  });

  it("200s and ignores a non-command update", async () => {
    const res = await tgPost({ update_id: 5, edited_message: { text: "x" } });
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toBeTruthy();
    expect(RECORDED_REPLIES).toHaveLength(0);
  });

  it("200s an unparseable body without throwing", async () => {
    const res = await telegramPOST(
      new Request("http://localhost/api/bots/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a request that fails the configured webhook secret", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret";
    const bad = await tgPost(tgUpdate("help", 9));
    expect(bad.status).toBe(401);
    const good = await tgPost(tgUpdate("help", 10), { "x-telegram-bot-api-secret-token": "s3cret" });
    expect(good.status).toBe(200);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });
});

describe("POST /api/bots/x", () => {
  it("places a bet from a v2 mention and threads the reply", async () => {
    const res = await xPOST(
      new Request("http://localhost/api/bots/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { id: "1780", text: `@hunch bet 3 YES on ${SLUG}`, author_id: "9" } }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).placed).toBe(true);
    expect(RECORDED_REPLIES[0].platform).toBe("x");
    expect(RECORDED_REPLIES[0].inReplyToMentionId).toBe("x:1780");
  });

  it("answers the CRC challenge on GET", async () => {
    const res = await xGET(new Request("http://localhost/api/bots/x?crc_token=abc"));
    expect(res.status).toBe(200);
    expect((await res.json()).response_token).toBe("sha256=abc");
  });
});
