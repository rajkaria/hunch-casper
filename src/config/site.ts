/**
 * The site's public base URL — the one place that decides where "this deployment" lives.
 *
 * Chat replies, embed links, and oEmbed responses all quote absolute URLs, and they must point at
 * wherever the app is actually served: the production domain by default, but a preview deployment
 * or a custom domain when that is where a user is. Order of preference:
 *
 *   1. `NEXT_PUBLIC_SITE_URL` — an explicit operator override, always wins.
 *   2. `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL` — the deployment's own domain, so preview
 *      builds link to themselves instead of to production.
 *   3. the canonical production domain.
 *
 * Returned without a trailing slash so callers can append `/markets/<slug>` cleanly.
 */

const CANONICAL = "https://casper.playhunch.xyz";

export function siteBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return stripTrailingSlash(withProtocol(explicit));
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercel) return stripTrailingSlash(withProtocol(vercel));
  return CANONICAL;
}

/** The public page for a market slug. */
export function marketUrl(slug: string): string {
  return `${siteBaseUrl()}/markets/${slug}`;
}

/** The embeddable odds widget for a market slug. */
export function embedUrl(slug: string): string {
  return `${siteBaseUrl()}/embed/${slug}`;
}

function withProtocol(host: string): string {
  return /^https?:\/\//i.test(host) ? host : `https://${host}`;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
