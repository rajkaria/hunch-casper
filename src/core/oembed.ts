/**
 * Pure oEmbed response builder (https://oembed.com). Given the slug of one of our markets and the
 * base URL, produce the `rich`-type oEmbed document a consumer (Slack, Discord, a CMS) renders as
 * an inline card: an `<iframe>` pointing at `/embed/<slug>`. Pure so the response shape is tested
 * without a route; the endpoint is a thin validator + this.
 */

export interface OEmbedRich {
  version: "1.0";
  type: "rich";
  provider_name: string;
  provider_url: string;
  title: string;
  html: string;
  width: number;
  height: number;
  cache_age: number;
}

export const OEMBED_DEFAULT_WIDTH = 480;
export const OEMBED_DEFAULT_HEIGHT = 320;
export const OEMBED_MAX_WIDTH = 800;
export const OEMBED_MAX_HEIGHT = 600;
const OEMBED_MIN = 120;

/** Clamp a requested dimension into a sane range, or fall back to the default when absent/invalid. */
export function clampDimension(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(OEMBED_MIN, Math.min(Math.floor(n), max));
}

export function buildOEmbed(input: {
  slug: string;
  title: string;
  embedUrl: string;
  siteUrl: string;
  width?: number;
  height?: number;
}): OEmbedRich {
  const width = input.width ?? OEMBED_DEFAULT_WIDTH;
  const height = input.height ?? OEMBED_DEFAULT_HEIGHT;
  // The HTML is quoted into JSON, but consumers inject it into a page, so escape the attribute
  // context: the URL is ours (safe) but width/height and the title come through here too.
  const src = escapeAttr(input.embedUrl);
  const html =
    `<iframe src="${src}" width="${width}" height="${height}" ` +
    `style="border:0;border-radius:14px;overflow:hidden" ` +
    `title="${escapeAttr(input.title)}" loading="lazy" ` +
    `sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>`;
  return {
    version: "1.0",
    type: "rich",
    provider_name: "Hunch on Casper",
    provider_url: input.siteUrl,
    title: input.title,
    html,
    width,
    height,
    cache_age: 60,
  };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Extract a market slug from an oEmbed `url` param. Accepts a bare slug or any of our
 * `/markets/<slug>` and `/embed/<slug>` URLs (host-agnostic, like the bot grammar), rejecting
 * anything else. Returns the lowercased slug or `null`.
 */
export function slugFromOEmbedUrl(raw: string): string | null {
  if (SLUG.test(raw.toLowerCase()) && !raw.includes("/")) return raw.toLowerCase();
  let path: string;
  try {
    path = new URL(raw).pathname;
  } catch {
    return null;
  }
  const match = /^\/(?:markets|embed)\/([^/]+)\/?$/.exec(path);
  if (!match) return null;
  let candidate: string;
  try {
    candidate = decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return null;
  }
  return SLUG.test(candidate) ? candidate : null;
}
