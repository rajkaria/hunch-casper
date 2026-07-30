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
import { notFound } from "next/navigation";
import { findDefinition } from "@/adapters/mock/market-source";
import { hydrateEconomyState } from "@/adapters/persist/economy-state";
import { siteBaseUrl, marketUrl } from "@/config/site";

/** Route params arrive still percent-encoded; malformed escapes fall through unchanged. */
function decodeSlug(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug: rawSlug } = await params;
  // Two fixes with one cause — every round/created market page carried the generic "Market" title:
  //   1. the param is still percent-encoded (a round slug arrives as `cspr-hourly-updown%2320658`),
  //      so the catalogue lookup needs the decoded form;
  //   2. created/round markets live in the KV snapshot, not the static catalogue — hydrate first
  //      (a fast no-op when persistence is unconfigured), exactly as the market API routes do.
  const slug = decodeSlug(rawSlug);
  await hydrateEconomyState();
  const definition = findDefinition(slug);
  // No such market on either network → a real 404, not a soft-404 shell page with "Market" as its
  // title. The definition set is the store's own source, so this cannot 404 a page that renders.
  if (!definition) notFound();
  const base = siteBaseUrl();
  // Built from the RAW (still-encoded) segment: a decoded `#` would read as a URL fragment.
  const pageUrl = marketUrl(rawSlug);
  const oembedUrl = `${base}/api/oembed?url=${encodeURIComponent(pageUrl)}&format=json`;

  const title = definition.title;
  const description =
    definition.subtitle ??
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
