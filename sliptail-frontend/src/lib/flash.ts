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
  localStorage.setItem(KEY, JSON.stringify(payload));
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