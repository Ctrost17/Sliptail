// hooks/useUnreadNotifications.ts
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type NotificationRecord = {
  id: number;
  type: string;
  title: string;
  body: string;
  metadata?: any; // NOTE: your DB column is `metadata`
  read_at: string | null;
  created_at: string;
};

type UseUnreadOpts = {
  /** Also fetch & maintain a small list for preview UIs */
  loadList?: boolean;
  /** Poll period when SSE is unavailable (ms). Default: 30000 */
  pollMs?: number;
  /** Initial unread to hydrate fast (optional) */
  initialUnread?: number;
  /** How many notifications to fetch if loadList. Default: 20 */
  listLimit?: number;
};

type UseUnreadReturn = {
  unread: number;
  hasUnread: boolean;
  loading: boolean;
  error: string | null;
  notifications: NotificationRecord[] | null;
  refresh: () => Promise<void>;
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
};

/** Build API base from NEXT_PUBLIC_API_URL (or same-origin /api) */
function apiBase() {
  const base = process.env.NEXT_PUBLIC_API_URL || "";
  const trimmed = base.replace(/\/$/, "");
  return trimmed ? `${trimmed}/api/notifications` : `/api/notifications`;
}

async function fetchJson<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init && init.headers ? init.headers : {}),
    },
    credentials: "include", // send cookies
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // ignore parse error; will throw below if !ok
  }
  if (!res.ok) {
    const msg = data?.error || data?.message || text || `HTTP ${res.status}`;
    throw new Error(String(msg));
  }
  return data as T;
}

export function useUnreadNotifications(opts: UseUnreadOpts = {}): UseUnreadReturn {
  const { loadList = false, pollMs = 30000, initialUnread, listLimit = 20 } = opts;

  const BASE = useMemo(apiBase, []);
  const mountedRef = useRef(true);
  const sseRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [unread, setUnread] = useState<number>(initialUnread ?? 0);
  const [notifications, setNotifications] = useState<NotificationRecord[] | null>(loadList ? [] : null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const setSafe = useCallback(<T,>(setter: (v: T) => void, v: T) => {
    if (mountedRef.current) setter(v);
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    // Prefer dedicated unread-count if available; fallback to list endpoint which returns { unread }
    try {
      const r = await fetchJson<{ unread: number }>(`${BASE}/unread-count`);
      setSafe(setUnread, r.unread || 0);
      setSafe(setError, null);
    } catch {
      try {
        const r = await fetchJson<{ unread: number }>(`${BASE}?limit=1&offset=0`);
        setSafe(setUnread, r.unread || 0);
        setSafe(setError, null);
      } catch (e: any) {
        setSafe(setError, e?.message || "Failed to fetch unread count");
      }
    }
  }, [BASE, setSafe]);

  const fetchList = useCallback(async () => {
    if (!loadList) return;
    try {
      const r = await fetchJson<{ notifications: NotificationRecord[]; unread: number }>(
        `${BASE}?limit=${listLimit}&offset=0`
      );
      setSafe(setNotifications, r.notifications || []);
      setSafe(setUnread, r.unread || 0);
      setSafe(setError, null);
    } catch (e: any) {
      setSafe(setError, e?.message || "Failed to fetch notifications");
    }
  }, [BASE, loadList, listLimit, setSafe]);

  const refresh = useCallback(async () => {
    setSafe(setLoading, true);
    await Promise.all([fetchUnreadCount(), fetchList()]);
    setSafe(setLoading, false);
  }, [fetchUnreadCount, fetchList, setSafe]);

  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    // Initial tick soon (stagger to avoid stampede)
    const first = setTimeout(() => fetchUnreadCount().catch(() => {}), 1500);
    pollTimerRef.current = setInterval(() => {
      fetchUnreadCount().catch(() => {});
    }, Math.max(5000, pollMs));
    // Clear the one-shot timer when we clear polling
    (pollTimerRef as any).first = first;
  }, [fetchUnreadCount, pollMs]);

  const stopPolling = useCallback(() => {
    if ((pollTimerRef as any).first) {
      clearTimeout((pollTimerRef as any).first);
      (pollTimerRef as any).first = null;
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const connectSSE = useCallback(() => {
    // Avoid duplicate connection
    if (sseRef.current) return;
    try {
      const url = `${BASE}/stream`;
      const es = new EventSource(url, { withCredentials: true });
      sseRef.current = es;

      // Generic message event
      es.onmessage = (ev: MessageEvent) => {
        try {
          const data = ev.data ? JSON.parse(ev.data) : null;
          if (!data) return;

          // Server may push either a badge update: { unread } or a new notification payload
          if (typeof data.unread === "number") {
            setSafe(setUnread, data.unread);
          }

          if (loadList && data.notification) {
            setSafe(setNotifications, (prev) => {
              const next = Array.isArray(prev) ? [data.notification as NotificationRecord, ...prev] : [data.notification];
              // dedupe by id
              const seen = new Set<number>();
              const unique = next.filter((n) => {
                if (!n) return false;
                if (seen.has(n.id)) return false;
                seen.add(n.id);
                return true;
              });
              return unique.slice(0, listLimit);
            });
          }
        } catch {
          // ignore malformed message
        }
      };

      es.addEventListener("badge", (ev: MessageEvent) => {
        try {
          const data = ev.data ? JSON.parse(ev.data) : null;
          if (data && typeof data.unread === "number") {
            setSafe(setUnread, data.unread);
          }
        } catch {}
      });

      es.onerror = () => {
        // Fall back to polling if the stream errors out
        es.close();
        sseRef.current = null;
        startPolling();
      };
    } catch {
      // If EventSource not supported or throws, fall back to polling
      startPolling();
    }
  }, [BASE, loadList, listLimit, setSafe, startPolling]);

  const disconnectSSE = useCallback(() => {
    if (sseRef.current) {
      try {
        sseRef.current.close();
      } catch {}
      sseRef.current = null;
    }
  }, []);

  // Mark one notification as read
  const markRead = useCallback(
    async (id: number) => {
      try {
        await fetchJson<{ success: true; id: number; read_at: string }>(`${BASE}/${id}/read`, { method: "POST" });
        setSafe(setUnread, (u) => Math.max(0, (u ?? 0) - 1));
        if (loadList) {
          setSafe(setNotifications, (prev) =>
            Array.isArray(prev)
              ? prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
              : prev
          );
        }
      } catch (e: any) {
        setSafe(setError, e?.message || "Failed to mark as read");
      }
    },
    [BASE, loadList, setSafe]
  );

  // Mark all as read
  const markAllRead = useCallback(async () => {
    try {
      await fetchJson<{ success: true }>(`${BASE}/read-all`, { method: "POST" });
      setSafe(setUnread, 0);
      if (loadList) {
        const nowIso = new Date().toISOString();
        setSafe(setNotifications, (prev) => (Array.isArray(prev) ? prev.map((n) => ({ ...n, read_at: nowIso })) : prev));
      }
    } catch (e: any) {
      setSafe(setError, e?.message || "Failed to mark all as read");
    }
  }, [BASE, loadList, setSafe]);

  // Mount / unmount
  useEffect(() => {
    mountedRef.current = true;

    // Initial fetch
    (async () => {
      try {
        await Promise.all([fetchUnreadCount(), fetchList()]);
      } finally {
        setSafe(setLoading, false);
      }
    })();

    // Try SSE; falls back to polling on error
    connectSSE();

    return () => {
      mountedRef.current = false;
      disconnectSSE();
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once

  return {
    unread,
    hasUnread: (unread ?? 0) > 0,
    loading,
    error,
    notifications,
    refresh,
    markRead,
    markAllRead,
  };
}

export default useUnreadNotifications;