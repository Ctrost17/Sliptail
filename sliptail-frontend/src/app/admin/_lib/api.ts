// app/admin/_lib/api.ts
import { headers } from "next/headers";

export async function getApiBase(): Promise<string> {
  const env = process.env.NEXT_PUBLIC_API_BASE?.trim();
  if (env) return env.replace(/\/$/, "");

  const h = await headers();
  const hostHeader = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const protoRaw = h.get("x-forwarded-proto");
  const proto = protoRaw?.split(",")[0]?.trim() || "http";

  // Dev-friendly fallback: if you're on localhost and didn't set the env,
  // assume API is on :5000 (change DEV_API_PORT to override).
  if (/localhost|127\.0\.0\.1/i.test(hostHeader)) {
    const devPort = (process.env.DEV_API_PORT || "5000").trim();
    return `${proto}://localhost:${devPort}`;
  }

  if (!hostHeader) {
    throw new Error(
      "API base could not be determined. Set NEXT_PUBLIC_API_BASE or ensure host headers are forwarded."
    );
  }
  return `${proto}://${hostHeader}`;
}

type QsValue = string | number | boolean | null | undefined;
type Qs = Record<string, QsValue>;

export async function apiUrl(path: string, qs?: Qs): Promise<string> {
  const base = await getApiBase();
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base);
  if (qs) {
    for (const [k, v] of Object.entries(qs)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}