import { headers } from "next/headers";

type QsValue = string | number | boolean | null | undefined;
type Qs = Record<string, QsValue>;

/**
 * Build a full absolute API base.
 * - If NEXT_PUBLIC_API_BASE is absolute (http/https) → use it.
 * - If it's relative (e.g. "/api") → prefix with request origin (proto + host).
 * - If it's missing → fall back to request origin, and in dev use :5000 if on localhost.
 */
export async function getApiOrigin(): Promise<string> {
  const h = await headers();
  const hostHeader = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const protoRaw = h.get("x-forwarded-proto");
  const proto = protoRaw?.split(",")[0]?.trim() || "http";
  return `${proto}://${hostHeader.replace(/\/$/, "")}`;
}

export async function getApiBase(): Promise<string> {
  const env = process.env.NEXT_PUBLIC_API_BASE?.trim();
  const origin = await getApiOrigin();

  if (env) {
    // Absolute base
    if (env.startsWith("http://") || env.startsWith("https://")) {
      return env.replace(/\/$/, "");
    }
    // Relative base (e.g. "/api") → attach to origin
    if (env.startsWith("/")) {
      return `${origin}${env.replace(/\/$/, "")}`;
    }
  }

  // No env: dev-friendly fallback — if on localhost, assume backend at :5000/api
  if (/localhost|127\.0\.0\.1/i.test(origin)) {
    const devPort = (process.env.DEV_API_PORT || "5000").trim();
    return `http://localhost:${devPort}/api`;
  }

  // Otherwise default to same-origin /api
  return `${origin}/api`;
}

/**
 * Build a full URL from base + path (+ optional query).
 * Always returns an absolute URL.
 */
export async function apiUrl(path: string, qs?: Qs): Promise<string> {
  const base = await getApiBase(); // absolute, no trailing slash
  let p = path.startsWith("/") ? path : `/${path}`;

  // De-duplicate "/api" if caller passes "/api/..." while base also ends with "/api"
  const baseHasApi = /\/api$/i.test(base);
  if (baseHasApi && p.startsWith("/api/")) {
    p = p.replace(/^\/api/, "");
  }

  const root = `${base}/`; // ensure single trailing slash
  const url = new URL(p.replace(/^\//, ""), root);

  if (qs) {
    for (const [k, v] of Object.entries(qs)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}
