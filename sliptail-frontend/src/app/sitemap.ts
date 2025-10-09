// app/sitemap.ts
import type { MetadataRoute } from "next";

const BASE_URL = "https://sliptail.com";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Static pages you want indexed
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/`,        lastModified: new Date(), changeFrequency: "weekly",  priority: 1 },
    { url: `${BASE_URL}/about`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.6 },
    { url: `${BASE_URL}/support`, lastModified: new Date(), changeFrequency: "yearly",  priority: 0.4 },
  ];

  // OPTIONAL: include dynamic creator profile pages
  let dynamic: MetadataRoute.Sitemap = [];
  try {
    const res = await fetch(`${BASE_URL}/api/creators`, { next: { revalidate: 3600 } });
    if (res.ok) {
      const data = (await res.json()) as { creators: { creator_id: number | string }[] };
      dynamic = (data.creators || []).map((c) => ({
        url: `${BASE_URL}/creators/${c.creator_id}`,
        lastModified: new Date(),
        changeFrequency: "daily",
        priority: 0.8,
      }));
    }
  } catch {
    // ignore if API not available — static routes still work
  }

  return [...staticRoutes, ...dynamic];
}