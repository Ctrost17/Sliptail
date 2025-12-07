import { headers } from "next/headers";

type QsValue = string | number | boolean | null | undefined;
type Qs = Record<string, QsValue>;

/**
 * Build a full absolute API origin.
 * - Uses x-forwarded-host / host when available.
 * - Falls back to NEXT_PUBLIC_API_URL / NEXT_PUBLIC_API_BASE or "sliptail.com".
 */
export async function getApiOrigin(): Promise<string> {
  const h = await headers();

  // Safe fallback host: strip scheme and trailing slash
  const fallbackHostRaw =
    process.env.NEXT_PUBLIC_API_URL ??
    process.env.NEXT_PUBLIC_API_BASE ??
    "https://sliptail.com";

  const fallbackHost = fallbackHostRaw
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const hostHeader =
    h.get("x-forwarded-host") ??
    h.get("host") ??
    fallbackHost;

  const protoRaw = h.get("x-forwarded-proto");
  // In production behind nginx, this should be "https"; default is fine either way
  const proto = protoRaw?.split(",")[0]?.trim() || "https";

  return `${proto}://${hostHeader.replace(/\/$/, "")}`;
}

export async function getApiBase(): Promise<string> {
  // Prefer either one of these envs
  const env = (
    process.env.NEXT_PUBLIC_API_BASE ??
    process.env.NEXT_PUBLIC_API_URL
  )?.trim();

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
