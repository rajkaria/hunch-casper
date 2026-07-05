import type { MetadataRoute } from "next";
import { MARKET_DEFINITIONS } from "@/core/catalogue";

const BASE = "https://casper.playhunch.xyz";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${BASE}/markets`, lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: `${BASE}/agents`, lastModified: now, changeFrequency: "hourly", priority: 0.8 },
    { url: `${BASE}/docs`, lastModified: now, changeFrequency: "weekly", priority: 0.7 },
  ];

  const marketRoutes: MetadataRoute.Sitemap = MARKET_DEFINITIONS.map((def) => ({
    url: `${BASE}/markets/${def.slug}`,
    lastModified: now,
    changeFrequency: "hourly",
    priority: 0.6,
  }));

  return [...staticRoutes, ...marketRoutes];
}
