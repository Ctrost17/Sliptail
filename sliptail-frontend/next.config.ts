// next.config.ts
import type { NextConfig } from "next";

/**
 * BACKEND ORIGIN (no trailing slash)
 * Dev: set in .env.local -> NEXT_PUBLIC_API_URL=http://localhost:5000
 * Prod: e.g. https://api.yourdomain.com
 */
const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: 'standalone', // Enable standalone build for Docker deployment
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

      // If your backend serves images in dev:
      { protocol: "http", hostname: "localhost", port: "5000" },
      { protocol: "http", hostname: "127.0.0.1", port: "5000" },
    ],
    // or: domains: ["images.unsplash.com", "i.pravatar.cc", "picsum.photos"]
  },
};

export default nextConfig;
