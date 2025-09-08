// src/lib/api.ts
import axios from "axios";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:5000";

// ---------- SSR-friendly fetch helper ----------
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function fetchApi<T>(
  path: string,
  options: {
    method?: HttpMethod;
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
    cache?: RequestCache;
    next?: { revalidate?: number | false };
  } = {}
): Promise<T> {
  const url =
    path.startsWith("http")
      ? path
      : `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;

  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (!isForm) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);

  const res = await fetch(url, {
    method: options.method || "GET",
    credentials: "include",
    headers,
    body: isForm ? (options.body as BodyInit) : options.body ? JSON.stringify(options.body) : undefined,
    cache: options.cache,
    next: options.next,
  });

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
      if (typeof j === "string") msg = j;
    } catch {}
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

// ---------- Axios client (for Client Components) ----------
export const api = axios.create({
  baseURL: `${API_BASE}/api`,
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