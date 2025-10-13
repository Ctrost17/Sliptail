// app/robots.ts
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" , disallow: ["/creators/","/admin","/dashboard","/settings","/terms","/privacy","/notifications,/purchases"]}],
    sitemap: "https://sliptail.com/sitemap.xml",
  };
}