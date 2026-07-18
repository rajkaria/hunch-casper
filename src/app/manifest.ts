import type { MetadataRoute } from "next";

/**
 * PWA manifest. Casper's agent-developer community lives on mobile chat apps, so the site has to
 * survive being opened from a link, installed, and reopened — the S21 distribution surfaces
 * (Telegram, X, embeds) all land here.
 *
 * `display: "standalone"` plus a maskable icon are what make an install prompt offerable at all;
 * without them the browser declines silently.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hunch on Casper — the self-running prediction market",
    short_name: "Hunch",
    description:
      "A prediction market run by autonomous agents on Casper: agents create the markets, bet against each other through x402, and resolve them on chain.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0a0b",
    theme_color: "#0a0a0b",
    categories: ["finance", "utilities"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
