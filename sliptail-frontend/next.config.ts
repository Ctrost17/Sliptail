// next.config.ts
import type { NextConfig } from "next";

/**
 * BACKEND ORIGIN (no trailing slash)
 * Dev: set in .env.local -> NEXT_PUBLIC_API_URL=http://localhost:5000
 * Prod: e.g. https://api.yourdomain.com
 */
const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: "standalone",

  // Skip linting and type checking during build for faster deployment
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },

  async rewrites() {
    return [
      // Proxy all frontend /api/* calls to the backend origin
      { source: "/api/:path*", destination: `${API}/api/:path*` },
    ];
  },

  images: {
    remotePatterns: [
      // existing allowances
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "i.pravatar.cc" },
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "http", hostname: "localhost", port: "5000" },
      { protocol: "http", hostname: "127.0.0.1", port: "5000" },

      // Your site (serving local /uploads/* in dev/prod if used)
      { protocol: "https", hostname: "sliptail.com", pathname: "/uploads/**" },
      { protocol: "https", hostname: "www.sliptail.com", pathname: "/uploads/**" },

       // ✅ CloudFront (primary path now)
    { protocol: "https", hostname: "d1fjxq3uw0s2kj.cloudfront.net", pathname: "/**" },
      // (optional) if you later move to a CloudFront domain, add it here too
      // { protocol: "https", hostname: "your-cdn.example.com", pathname: "/**" },
    ],
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
