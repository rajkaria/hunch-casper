import { describe, it, expect, afterEach } from "vitest";
import { createTelegramTransport } from "@/adapters/bots/telegram-transport";
import { createXTransport } from "@/adapters/bots/x-transport";
import { botsLive } from "@/adapters/bots/live-gate";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("telegram transport — parseUpdate", () => {
  const t = createTelegramTransport("test-token");
  it("normalises a text message update", () => {
    const msg = t.parseUpdate({
      update_id: 4210,
      message: { message_id: 5, from: { id: 777 }, chat: { id: -100200 }, text: "@bot bet 5 yes on m" },
    });
    expect(msg).toEqual({
      platform: "telegram",
      mentionId: "telegram:4210",
      text: "@bot bet 5 yes on m",
      replyTo: "-100200",
      sender: "telegram:777",
    });
  });

  it("ignores non-text and malformed updates", () => {
    expect(t.parseUpdate({ update_id: 1, message: { chat: { id: 1 } } })).toBeNull(); // no text
    expect(t.parseUpdate({ message: { text: "hi", chat: { id: 1 } } })).toBeNull(); // no update_id
    expect(t.parseUpdate({ update_id: 1, edited_message: { text: "x" } })).toBeNull(); // an edit
    expect(t.parseUpdate(null)).toBeNull();
    expect(t.parseUpdate("nope")).toBeNull();
  });
});

describe("x transport — parseUpdate", () => {
  const t = createXTransport("test-token");
  it("normalises a v2 mention webhook", () => {
    const msg = t.parseUpdate({ data: { id: "1780000000000000000", text: "@bot bet 5 yes on m", author_id: "42" } });
    expect(msg).toEqual({
      platform: "x",
      mentionId: "x:1780000000000000000",
      text: "@bot bet 5 yes on m",
      replyTo: "1780000000000000000",
      sender: "x:42",
    });
  });

  it("normalises a classic Account Activity webhook", () => {
    const msg = t.parseUpdate({
      tweet_create_events: [{ id_str: "999", text: "@bot odds m", user: { id_str: "7" } }],
    });
    expect(msg?.mentionId).toBe("x:999");
    expect(msg?.sender).toBe("x:7");
  });

  it("ignores unrelated payloads", () => {
    expect(t.parseUpdate({ favorite_events: [] })).toBeNull();
    expect(t.parseUpdate({ data: { id: "1" } })).toBeNull(); // no text
  });
});

describe("live-gate — the D2 kill switch", () => {
  afterEach(() => {
    delete process.env.HUNCH_BOTS_LIVE;
  });

  it("send refuses when the bots are not live", async () => {
    delete process.env.HUNCH_BOTS_LIVE;
    expect(botsLive()).toBe(false);
    await expect(createTelegramTransport("tok").send({ replyTo: "1", text: "hi" })).rejects.toThrow(/not live/);
    await expect(createXTransport("tok").send({ replyTo: "1", text: "hi" })).rejects.toThrow(/not live/);
  });

  it("send refuses when live but the credential is missing", async () => {
    process.env.HUNCH_BOTS_LIVE = "true";
    await expect(createTelegramTransport(undefined).send({ replyTo: "1", text: "hi" })).rejects.toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
    await expect(createXTransport(undefined).send({ replyTo: "1", text: "hi" })).rejects.toThrow(/X_BOT_BEARER_TOKEN/);
  });
});
