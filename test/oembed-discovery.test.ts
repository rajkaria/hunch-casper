/**
 * The oEmbed discovery contract.
 *
 * `/api/oembed` worked and nothing could find it: consumers (Slack, Discord, Notion, every
 * unfurler) do not guess endpoint URLs, they read a `<link rel="alternate">` tag off the page. A
 * working endpoint with no discovery tag is unreachable in practice.
 *
 * These tests pin the loop closed — the URL the tag advertises must be one the endpoint actually
 * serves. A tag pointing at a URL that 400s would be worse than no tag at all.
 */

import { describe, expect, it } from "vitest";
import { generateMetadata } from "@/app/markets/[slug]/layout";
import { GET as oembed } from "@/app/api/oembed/route";
import { MARKET_DEFINITIONS } from "@/core/catalogue";

const SLUG = MARKET_DEFINITIONS[0].slug;

async function metaFor(slug: string) {
  return generateMetadata({ params: Promise.resolve({ slug }) });
}

function oembedHref(meta: Awaited<ReturnType<typeof metaFor>>): string {
  const types = meta.alternates?.types as Record<string, Array<{ url: string }>> | undefined;
  const entry = types?.["application/json+oembed"]?.[0];
  return String(entry?.url ?? "");
}

describe("oEmbed discovery", () => {
  it("emits an application/json+oembed alternate link", () => {
    return metaFor(SLUG).then((meta) => {
      expect(oembedHref(meta)).toContain("/api/oembed");
    });
  });

  it("the advertised URL carries the market page as its target", async () => {
    const href = oembedHref(await metaFor(SLUG));
    const url = new URL(href);
    expect(url.searchParams.get("url")).toContain(`/markets/${SLUG}`);
    expect(url.searchParams.get("format")).toBe("json");
  });

  it("the endpoint actually serves the URL the tag advertises", async () => {
    // The loop that matters: a tag pointing somewhere that 400s is worse than no tag.
    const href = oembedHref(await metaFor(SLUG));
    const res = await oembed(new Request(href));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type?: string; html?: string };
    expect(body.type).toBe("rich");
    expect(body.html).toContain("iframe");
  });

  it("carries the market's real title, not a placeholder", async () => {
    const meta = await metaFor(SLUG);
    expect(meta.title).toBe(MARKET_DEFINITIONS[0].title);
  });

  it("sets a canonical URL and OpenGraph tags for unfurlers without oEmbed", async () => {
    const meta = await metaFor(SLUG);
    expect(String(meta.alternates?.canonical)).toContain(`/markets/${SLUG}`);
    expect(meta.openGraph?.title).toBe(MARKET_DEFINITIONS[0].title);
  });

  it("degrades to a generic title for an unknown slug rather than throwing", async () => {
    await expect(metaFor("no-such-market")).resolves.toBeDefined();
    expect((await metaFor("no-such-market")).title).toBe("Market");
  });

  it("percent-encodes a slug so a crafted one cannot break out of the query", async () => {
    const href = oembedHref(await metaFor("a b&c=d"));
    expect(href).not.toContain("&c=d&");
    expect(new URL(href).searchParams.get("url")).toContain("a b&c=d");
  });
});
