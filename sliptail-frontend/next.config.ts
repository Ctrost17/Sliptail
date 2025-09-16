// next.config.ts
import type { NextConfig } from "next";

/**
 * BACKEND ORIGIN (no trailing slash)
 * Dev: NEXT_PUBLIC_API_URL=http://localhost:5000
 * Prod: e.g. https://api.yourdomain.com
 */
const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");

// Derive host info for remotePatterns based on API
let apiPattern: { protocol: "http" | "https"; hostname: string; port?: string; pathname?: string } | null = null;
try {
  const u = new URL(API);
  apiPattern = {
    protocol: (u.protocol.replace(":", "") as "http" | "https") || "http",
    hostname: u.hostname,
    ...(u.port ? { port: u.port } : {}),
    pathname: "/uploads/**", // only allow uploaded assets
  };
} catch {
  // ignore if NEXT_PUBLIC_API_URL isn't a valid URL at build time
}

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // Proxy all frontend /api/* calls to the backend origin
      { source: "/api/:path*", destination: `${API}/api/:path*` },
    ];
  },

  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "i.pravatar.cc" },
      { protocol: "https", hostname: "picsum.photos" },

      // Dev API image host(s)
      { protocol: "http", hostname: "localhost", port: "5000", pathname: "/uploads/**" },
      { protocol: "http", hostname: "127.0.0.1", port: "5000", pathname: "/uploads/**" },

      // Prod/Custom API host from NEXT_PUBLIC_API_URL (if present)
      ...(apiPattern ? [apiPattern] as const : []),
    ],
  },
};

export default nextConfig;