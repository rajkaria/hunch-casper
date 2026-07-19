/**
 * GET /api/oembed?url=<market-or-embed-url>&format=json&maxwidth=&maxheight= — the oEmbed provider
 * endpoint (https://oembed.com). A consumer that discovers this endpoint (Slack, Discord, a CMS)
 * calls it with a market URL and gets back a `rich` card wrapping the `/embed/<slug>` iframe.
 *
 * SSR + no client secrets: the market is read server-side through the container; the response is
 * pure JSON built by `buildOEmbed`. Only JSON is offered — `format=xml` returns 501 rather than a
 * half-supported second serialisation.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";
import {
  buildOEmbed,
  clampDimension,
  slugFromOEmbedUrl,
  OEMBED_DEFAULT_WIDTH,
  OEMBED_DEFAULT_HEIGHT,
  OEMBED_MAX_WIDTH,
  OEMBED_MAX_HEIGHT,
} from "@/core/oembed";
import { embedUrl, siteBaseUrl } from "@/config/site";

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;

  const format = params.get("format");
  if (format && format !== "json") {
    return NextResponse.json({ error: "only format=json is supported" }, { status: 501 });
  }

  const target = params.get("url");
  if (!target) {
    return NextResponse.json({ error: "url parameter is required" }, { status: 400 });
  }
  const slug = slugFromOEmbedUrl(target);
  if (!slug) {
    return NextResponse.json({ error: "url is not a Hunch on Casper market" }, { status: 404 });
  }

  const netParam = params.get("network");
  const network = isCasperNetwork(netParam) ? netParam : DEFAULT_NETWORK;
  const container = createContainer(network);
  const market = await container.store.get(slug, network);
  if (!market) {
    return NextResponse.json({ error: `no market '${slug}' on ${network}` }, { status: 404 });
  }

  const width = clampDimension(params.get("maxwidth"), OEMBED_DEFAULT_WIDTH, OEMBED_MAX_WIDTH);
  const height = clampDimension(params.get("maxheight"), OEMBED_DEFAULT_HEIGHT, OEMBED_MAX_HEIGHT);
  const doc = buildOEmbed({
    slug,
    title: market.title,
    embedUrl: `${embedUrl(slug)}${network !== DEFAULT_NETWORK ? `?network=${network}` : ""}`,
    siteUrl: siteBaseUrl(),
    width,
    height,
  });

  return NextResponse.json(doc, {
    status: 200,
    headers: { "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" },
  });
}
