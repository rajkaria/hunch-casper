/**
 * GET /embed/[slug]?network=testnet|mainnet — the embeddable odds widget.
 *
 * Served as a Route Handler returning a complete, self-contained HTML document rather than a
 * `page.tsx`, on purpose: an embed must NOT inherit the site's root layout (header, footer, mainnet
 * banner, wallet context) — it is framed on third-party pages and has to be chrome-free, isolated,
 * and cache-friendly. A route handler gives full control of the document and the cache headers with
 * no client JavaScript and no secrets. The markup is produced by the pure `renderEmbed` so it is
 * unit-tested independently (decision D-EMBED).
 */

import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";
import { renderEmbed, renderEmbedNotFound } from "@/core/embed-render";
import { marketUrl, siteBaseUrl } from "@/config/site";

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  // Cacheable at the edge for a minute, served stale for five while revalidating — odds move, but
  // an embed a minute behind is fine and this keeps a viral embed off the origin.
  "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
  // The whole point is to be framed anywhere; it carries no auth or secrets.
  "content-security-policy": "frame-ancestors *",
} as const;

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  const netParam = new URL(req.url).searchParams.get("network");
  const network = isCasperNetwork(netParam) ? netParam : DEFAULT_NETWORK;

  const container = createContainer(network);
  const market = await container.store.get(slug, network);
  if (!market) {
    return new Response(renderEmbedNotFound(slug, siteBaseUrl()), {
      status: 404,
      headers: { ...HTML_HEADERS, "cache-control": "public, max-age=30" },
    });
  }

  const html = renderEmbed(market, { marketUrl: marketUrl(market.slug), siteUrl: siteBaseUrl() });
  return new Response(html, { status: 200, headers: HTML_HEADERS });
}
