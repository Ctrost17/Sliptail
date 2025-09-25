// src/lib/api.ts
import axios from "axios";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:5000";

// ---------- Domain types (minimal, from your backend's toSafeUser) ----------
export interface ApiUser {
  id: number;
  email: string;
  username: string | null;
  role: string; // keep open; tighten if you have a union
  email_verified_at: string | null; // ISO string or null
  created_at: string; // ISO string
}

export interface MeResponse {
  user: ApiUser;
}

// ---------- SSR-friendly fetch helper ----------
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// small helper to safely probe JSON
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function fetchApi<T>(
  path: string,
  options: {
    method?: HttpMethod;
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
    cache?: RequestCache;
    next?: { revalidate?: number | false };
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const url =
    path.startsWith("http")
      ? path
      : `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;

  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");

  // Only set JSON content-type if we're not sending FormData
  const isForm =
    typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!isForm && options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);

  const res = await fetch(url, {
    method: options.method || "GET",
    credentials: "include", // send cookies for auth
    headers,
    body: isForm
      ? (options.body as BodyInit)
      : options.body !== undefined
      ? JSON.stringify(options.body)
      : undefined,
    cache: options.cache,
    next: options.next,
    signal: options.signal,
  });

  if (!res.ok) {
    // Try to extract a meaningful error message without using `any`
    let msg = `${res.status} ${res.statusText}`;
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j: unknown = await res.json();
        if (isRecord(j)) {
          if (typeof j.error === "string") msg = j.error;
          else if (typeof (j as unknown as string) === "string") {
            // fallback if API returns a raw string JSON
            msg = j as unknown as string;
          }
        }
      } else {
        const t = await res.text();
        if (t) msg = t;
      }
    } catch {
      // ignore parse errors; fall back to default msg
    }
    if (res.status === 401) msg = "Unauthorized (no token)";
    throw new Error(msg);
  }

  // Some endpoints may return 204 No Content
  if (res.status === 204) return undefined as unknown as T;

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return (await res.json()) as T;
  }
  // Fallback: text
  return (await res.text()) as unknown as T;
}

// ---------- Axios client (for Client Components) ----------
export const api = axios.create({
  baseURL: `${API_BASE}/api`,
  withCredentials: true, // send cookies with requests
  headers: {
    Accept: "application/json",
  },
});

// Optional: call this after login/logout to keep auth header in sync
export function setAuthToken(token: string | null) {
  if (token) {
    api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common["Authorization"];
  }
}

// Small helpers if you like Axios ergonomics
export async function apiGet<T>(url: string, config?: Parameters<typeof api.get>[1]) {
  const res = await api.get<T>(url, config);
  return res.data;
}
export async function apiPost<T>(url: string, data?: unknown, config?: Parameters<typeof api.post>[2]) {
  const res = await api.post<T>(url, data, config);
  return res.data;
}
export async function apiPut<T>(url: string, data?: unknown, config?: Parameters<typeof api.put>[2]) {
  const res = await api.put<T>(url, data, config);
  return res.data;
}
export async function apiPatch<T>(url: string, data?: unknown, config?: Parameters<typeof api.patch>[2]) {
  const res = await api.patch<T>(url, data, config);
  return res.data;
}
export async function apiDelete<T>(url: string, config?: Parameters<typeof api.delete>[1]) {
  const res = await api.delete<T>(url, config);
  return res.data;
}

/* =========================
   Email/token flow helpers
   ========================= */

/** Backend verifies both signup and "new email" with the same endpoint. */
export async function verifyEmailToken(token: string): Promise<void> {
  // Returns HTML/redirect; we just ensure it 2xx's.
  await fetchApi<string>(`/api/auth/verify?token=${encodeURIComponent(token)}`, {
    method: "GET",
  });
}

/** Alias for clarity if you call from /verify-new-email page. */
export const verifyNewEmailToken = verifyEmailToken;

/** Reset password with token. */
export interface ResetPasswordResponse {
  success: boolean;
  message?: string;
}
export async function resetPassword(token: string, password: string) {
  return fetchApi<ResetPasswordResponse>("/api/auth/reset", {
    method: "POST",
    body: { token, password },
  });
}

/** Current user (useful for guarding /purchases). */
export async function me() {
  return fetchApi<MeResponse>("/api/auth/me", { method: "GET" });
}