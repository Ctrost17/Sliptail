// lib/flash.ts
export type FlashKind = "success" | "error" | "info";
export interface FlashPayload {
  kind: FlashKind;
  title: string;
  message?: string;
  ts: number;
}

const KEY = "sliptail_flash";

export function setFlash(payload: FlashPayload) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(KEY, JSON.stringify(payload)); } catch {}
}

export function consumeFlash(): FlashPayload | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  localStorage.removeItem(KEY);
  try {
    const parsed = JSON.parse(raw) as FlashPayload;
    // ignore stale flashes (> 2 minutes)
    if (Date.now() - (parsed.ts ?? 0) > 2 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * NEW: Read `?toast=` and optional `k=` (success|error|info) once from the URL,
 * then remove those params from the address bar (no reload).
 * This makes toasts reliable on iOS after a redirect.
 */
export function consumeUrlToast(): FlashPayload | null {
  if (typeof window === "undefined") return null;

  const url = new URL(window.location.href);
  const title = url.searchParams.get("toast");
  if (!title) return null;

  const k = (url.searchParams.get("k") || "success").toLowerCase();
  const kind: FlashKind = k === "error" ? "error" : k === "info" ? "info" : "success";

  url.searchParams.delete("toast");
  url.searchParams.delete("k");
  try { window.history.replaceState({}, "", url.toString()); } catch {}

  return { kind, title, ts: Date.now() };
}