// hooks/useUnreadNotifications.ts
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type NotificationRecord = {
  id: number;
  type: string | null;
  title: string | null;
  body: string | null;
  metadata?: Record<string, unknown> | null; // DB column name is `metadata`
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
function notificationsBase(): string {
  const base = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
  return base ? `${base}/api/notifications` : "/api/notifications";
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const txt = await res.text();
  let data: unknown = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    /* ignore parse error; will throw below if !ok */
  }
  if (!res.ok) {
    const msg =
      (data as { error?: string; message?: string } | null)?.error ||
      (data as { error?: string; message?: string } | null)?.message ||
      txt ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export function useUnreadNotifications(opts: UseUnreadOpts = {}): UseUnreadReturn {
  const { loadList = false, pollMs = 30000, initialUnread, listLimit = 20 } = opts;

  const BASE = useMemo(notificationsBase, []);
  const mountedRef = useRef(true);

  const [unread, setUnread] = useState<number>(initialUnread ?? 0);
  const [notifications, setNotifications] = useState<NotificationRecord[] | null>(
    loadList ? [] : null
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // timers / connections
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firstTickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  const setSafe = useCallback(<T,>(setter: (v: T) => void, v: T) => {
    if (mountedRef.current) setter(v);
  }, []);

  const broadcastPing = useCallback(() => {
    // Helps update other tabs quickly
    if (typeof window !== "undefined") {
      localStorage.setItem("notifications:ping", String(Date.now()));
    }
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const r = await fetchJson<{ unread: number }>(`${BASE}/unread-count`);
      setSafe(setUnread, r.unread ?? 0);
      setSafe(setError, null);
    } catch {
      // Fallback to list endpoint which returns { unread }
      try {
        const r = await fetchJson<{ unread: number }>(`${BASE}?limit=1&offset=0`);
        setSafe(setUnread, r.unread ?? 0);
        setSafe(setError, null);
      } catch (err) {
        setSafe(setError, getErrorMessage(err));
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
      setSafe(setUnread, r.unread ?? 0);
      setSafe(setError, null);
    } catch (err) {
      setSafe(setError, getErrorMessage(err));
    }
  }, [BASE, loadList, listLimit, setSafe]);

  const refresh = useCallback(async () => {
    setSafe(setLoading, true);
    try {
      await Promise.all([fetchUnreadCount(), fetchList()]);
    } finally {
      setSafe(setLoading, false);
    }
  }, [fetchUnreadCount, fetchList, setSafe]);

  // Polling
  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return;

    // initial gentle tick
    firstTickTimeoutRef.current = setTimeout(() => {
      void fetchUnreadCount();
    }, 1200);

    pollIntervalRef.current = setInterval(() => {
      void fetchUnreadCount();
    }, Math.max(5000, pollMs));
  }, [fetchUnreadCount, pollMs]);

  const stopPolling = useCallback(() => {
    if (firstTickTimeoutRef.current) {
      clearTimeout(firstTickTimeoutRef.current);
      firstTickTimeoutRef.current = null;
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // SSE (optional; falls back to polling if unavailable)
  const connectSSE = useCallback(() => {
    if (sseRef.current) return;
    try {
      const es = new EventSource(`${BASE}/stream`, { withCredentials: true });
      sseRef.current = es;

      es.onmessage = (ev: MessageEvent) => {
        try {
          const payload = ev.data ? (JSON.parse(ev.data) as unknown) : null;
          if (payload && typeof (payload as { unread?: number }).unread === "number") {
            setSafe(setUnread, (payload as { unread: number }).unread);
          }
          if (
            loadList &&
            payload &&
            typeof (payload as { notification?: NotificationRecord }).notification === "object"
          ) {
            const n = (payload as { notification: NotificationRecord }).notification;
            setSafe(setNotifications, (prev) => {
              const base = Array.isArray(prev) ? prev : [];
              const next = [n, ...base];
              const seen = new Set<number>();
              const dedup = next.filter((x) => {
                if (!x) return false;
                if (seen.has(x.id)) return false;
                seen.add(x.id);
                return true;
              });
              return dedup.slice(0, listLimit);
            });
          }
        } catch {
          /* ignore bad event payload */
        }
      };

      es.onerror = () => {
        es.close();
        sseRef.current = null;
        startPolling();
      };
    } catch {
      startPolling();
    }
  }, [BASE, loadList, listLimit, setSafe, startPolling]);

  const disconnectSSE = useCallback(() => {
    if (sseRef.current) {
      try {
        sseRef.current.close();
      } catch {
        /* no-op */
      }
      sseRef.current = null;
    }
  }, []);

  // Mark one as read
  const markRead = useCallback(
    async (id: number) => {
      try {
        await fetchJson<{ success: true; id: number; read_at: string }>(`${BASE}/${id}/read`, {
          method: "POST",
        });
        setSafe(setUnread, (u) => Math.max(0, (u ?? 0) - 1));
        if (loadList) {
          const now = new Date().toISOString();
          setSafe(setNotifications, (prev) =>
            Array.isArray(prev) ? prev.map((n) => (n.id === id ? { ...n, read_at: now } : n)) : prev
          );
        }
        broadcastPing();
      } catch (err) {
        setSafe(setError, getErrorMessage(err));
      }
    },
    [BASE, loadList, setSafe, broadcastPing]
  );

  // Mark all as read
  const markAllRead = useCallback(async () => {
    try {
      await fetchJson<{ success: true }>(`${BASE}/read-all`, { method: "POST" });
      setSafe(setUnread, 0);
      if (loadList) {
        const now = new Date().toISOString();
        setSafe(setNotifications, (prev) =>
          Array.isArray(prev) ? prev.map((n) => ({ ...n, read_at: now })) : prev
        );
      }
      broadcastPing();
    } catch (err) {
      setSafe(setError, getErrorMessage(err));
    }
  }, [BASE, loadList, setSafe, broadcastPing]);

  // Visibility → quick refresh when user returns to the tab
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void fetchUnreadCount();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [fetchUnreadCount]);

  // Cross-tab sync (when another tab marks read)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "notifications:ping") {
        void fetchUnreadCount();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [fetchUnreadCount]);

  // Mount / unmount
  useEffect(() => {
    mountedRef.current = true;

    (async () => {
      try {
        await Promise.all([fetchUnreadCount(), fetchList()]);
      } finally {
        setSafe(setLoading, false);
      }
    })();

    connectSSE(); // will fall back to polling if SSE endpoint missing

    return () => {
      mountedRef.current = false;
      disconnectSSE();
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
