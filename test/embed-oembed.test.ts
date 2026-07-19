import { describe, it, expect, beforeEach } from "vitest";
import { GET as embedGET } from "@/app/embed/[slug]/route";
import { GET as oembedGET } from "@/app/api/oembed/route";
import { renderEmbed, renderEmbedNotFound, escapeHtml } from "@/core/embed-render";
import { buildOEmbed, slugFromOEmbedUrl, clampDimension } from "@/core/oembed";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import type { Market } from "@/core/types";

beforeEach(() => __resetLedger());

const SLUG = "cspr-price-05-aug";

const MARKET: Market = {
  id: "testnet:demo",
  slug: "demo",
  title: `Will <script> "win" & prevail?`,
  category: "casper-native",
  outcomes: [
    { key: "yes", label: "Yes" },
    { key: "no", label: "No" },
  ],
  network: "testnet",
  status: "open",
  feeBps: 200,
  deadlineIso: "2026-08-01T00:00:00.000Z",
  totalStakedMotes: "2000000000000",
  poolByOutcomeMotes: { yes: "1200000000000", no: "800000000000" },
};

describe("renderEmbed", () => {
  const html = renderEmbed(MARKET, { marketUrl: "https://x.test/markets/demo", siteUrl: "https://x.test" });

  it("is a complete self-contained document with no external requests or client JS", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\/(?!x\.test)/); // only our own links, no CDN/font/api hosts
    expect(html).toContain("prefers-color-scheme"); // theme-aware
  });

  it("escapes an untrusted market title", () => {
    expect(html).not.toContain('Will <script>');
    expect(html).toContain("Will &lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("renders both outcomes with their pool-implied odds", () => {
    expect(html).toContain("Yes");
    expect(html).toContain("No");
    expect(html).toContain("60%"); // yes = 1200/2000
    expect(html).toContain("40%"); // no  = 800/2000
  });

  it("carries an attributed bet link", () => {
    expect(html).toContain("utm_source=embed");
    expect(html).toContain("Bet on this");
  });

  it("escapeHtml handles every dangerous character", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});

describe("GET /embed/[slug]", () => {
  it("serves an SSR widget for a real market with cache + frame-ancestors headers", async () => {
    const res = await embedGET(new Request(`http://localhost/embed/${SLUG}`), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("s-maxage");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors *");
    const body = await res.text();
    expect(body).toContain("Bet on this");
  });

  it("degrades a missing market to a 404 link document", async () => {
    const res = await embedGET(new Request("http://localhost/embed/ghost"), {
      params: Promise.resolve({ slug: "ghost" }),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not found");
    expect(renderEmbedNotFound("ghost", "https://x.test")).toContain("ghost");
  });
});

describe("oEmbed builder", () => {
  it("builds a rich iframe card", () => {
    const doc = buildOEmbed({
      slug: "demo",
      title: "Demo market",
      embedUrl: "https://x.test/embed/demo",
      siteUrl: "https://x.test",
      width: 480,
      height: 320,
    });
    expect(doc.type).toBe("rich");
    expect(doc.version).toBe("1.0");
    expect(doc.html).toContain('<iframe src="https://x.test/embed/demo"');
    expect(doc.html).toContain('width="480"');
    expect(doc.provider_name).toBe("Hunch on Casper");
  });

  it("extracts a slug from bare, market, and embed URLs; rejects the rest", () => {
    expect(slugFromOEmbedUrl("cspr-price-05-aug")).toBe("cspr-price-05-aug");
    expect(slugFromOEmbedUrl("https://casper.playhunch.xyz/markets/cspr-price-05-aug")).toBe("cspr-price-05-aug");
    expect(slugFromOEmbedUrl("https://x.test/embed/demo/")).toBe("demo");
    expect(slugFromOEmbedUrl("https://x.test/other/demo")).toBeNull();
    expect(slugFromOEmbedUrl("not a url with spaces")).toBeNull();
    expect(slugFromOEmbedUrl("https://x.test/markets/BAD_SLUG")).toBeNull();
  });

  it("clamps requested dimensions", () => {
    expect(clampDimension(null, 480, 800)).toBe(480);
    expect(clampDimension("100000", 480, 800)).toBe(800);
    expect(clampDimension("10", 480, 800)).toBe(120); // floor
    expect(clampDimension("abc", 480, 800)).toBe(480);
    expect(clampDimension("500", 480, 800)).toBe(500);
  });
});

describe("GET /api/oembed", () => {
  function oembed(qs: string): Promise<Response> {
    return oembedGET(new Request(`http://localhost/api/oembed?${qs}`));
  }

  it("returns a rich card for a real market URL", async () => {
    const res = await oembed(`url=${encodeURIComponent(`https://casper.playhunch.xyz/markets/${SLUG}`)}`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.type).toBe("rich");
    expect(doc.html).toContain(`/embed/${SLUG}`);
    expect(res.headers.get("cache-control")).toContain("s-maxage");
  });

  it("400s a missing url, 404s an unknown market, 501s a non-json format", async () => {
    expect((await oembed("")).status).toBe(400);
    expect((await oembed("url=https://x.test/markets/ghost")).status).toBe(404);
    expect((await oembed(`url=${SLUG}&format=xml`)).status).toBe(501);
  });
});
