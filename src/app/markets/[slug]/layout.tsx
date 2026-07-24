/**
 * Route-segment metadata for a market page — including the oEmbed **discovery link**.
 *
 * `/api/oembed` has worked for a while and nothing could find it. oEmbed consumers (Slack,
 * Discord, Notion, WordPress, every unfurler) do not guess endpoint URLs; they fetch the page and
 * look for `<link rel="alternate" type="application/json+oembed">`. Without that tag a working
 * endpoint is unreachable in practice, which is why pasting a market link anywhere produced a bare
 * URL instead of a card.
 *
 * It lives in a layout rather than the page because the page is a client component, and client
 * components cannot export `generateMetadata`. The layout is a server component, renders nothing
 * of its own, and exists purely to emit the tags.
 */

import type { Metadata } from "next";
import { findDefinition } from "@/adapters/mock/market-source";
import { siteBaseUrl, marketUrl } from "@/config/site";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const definition = findDefinition(slug);
  const base = siteBaseUrl();
  const pageUrl = marketUrl(slug);
  const oembedUrl = `${base}/api/oembed?url=${encodeURIComponent(pageUrl)}&format=json`;

  const title = definition?.title ?? "Market";
  const description =
    definition?.subtitle ??
    "A prediction market on Casper, settled by pure parimutuel contract math.";

  return {
    title,
    description,
    alternates: {
      canonical: pageUrl,
      types: {
        // The tag every unfurler actually looks for.
        "application/json+oembed": [{ url: oembedUrl, title }],
      },
    },
    openGraph: {
      type: "website",
      url: pageUrl,
      title,
      description,
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default function MarketLayout({ children }: { children: React.ReactNode }) {
  return children;
}
