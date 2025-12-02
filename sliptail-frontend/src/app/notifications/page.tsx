"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Notification = {
  id: number;
  title: string | null;
  body: string | null;
  type: string | null;
  metadata?: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
};

// Response shape from API: identical to Notification except metadata may be unknown (string/object/null)
type ApiNotification = Omit<Notification, "metadata"> & { metadata?: unknown };

// Safe JSON parser that never uses `any`
function safeParse<T = unknown>(v: unknown): T | null {
  if (typeof v !== "string") return (v as T) ?? null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ✅ Always hit same-origin so the HttpOnly cookie is sent
  // (Nginx proxies /api -> backend). Avoid absolute NEXT_PUBLIC_API_URL here.
  const api = useMemo(() => {
    // allow optional prefix override if you ever need it:
    const prefix = "";
    return {
      list: (qs: string) => `${prefix}/api/notifications?${qs}`,
      unreadCount: () => `${prefix}/api/notifications/unread-count`,
      stream: () => `${prefix}/api/notifications/stream`,
      markRead: (id: number) => `${prefix}/api/notifications/${id}/read`,
      markAll: () => `${prefix}/api/notifications/read-all`,
    };
  }, []);

  const handleUnauthorized = useCallback(() => {
    try {
      // clear any local hints of auth; your HttpOnly cookie is invalid anyway
      localStorage.removeItem("auth");
      localStorage.removeItem("token");
    } catch {}
    const next = encodeURIComponent("/notifications");
    window.location.href = `/auth/login?next=${next}`;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // IMPORTANT: many backends expect 1/0, not true/false
      const qs = new URLSearchParams({
        limit: "50",
        offset: "0",
        unread_only: unreadOnly ? "1" : "0",
      });
      const res = await fetch(api.list(qs.toString()), {
        credentials: "include",
        cache: "no-store",
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        setError(`Failed to load (${res.status})`);
        setItems([]);
      } else {
        const data: { notifications?: ApiNotification[] } = await res.json();

        // Normalize metadata in case the API returns it as JSON text or unknown
        const normalized: Notification[] = (data?.notifications ?? []).map((n) => {
          // If metadata is a string, try to parse; if it's already an object, keep it; otherwise null
          const parsed =
            typeof n.metadata === "string"
              ? safeParse<Record<string, unknown>>(n.metadata)
              : typeof n.metadata === "object" && n.metadata !== null
              ? (n.metadata as Record<string, unknown>)
              : null;

          return {
            ...n,
            metadata: parsed,
          };
        });

        setItems(normalized);
      }
    } catch {
      setError("Network error");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [api, unreadOnly, handleUnauthorized]);

  useEffect(() => {
    load();
  }, [load]);

  // Debounced refresh helper to avoid hammering API on bursty SSE events
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      load();
      refreshTimer.current = null;
    }, 250);
  }, [load]);

  // Live updates via SSE (with credentials)
  useEffect(() => {
    let source: EventSource | null = null;
    try {
      // Some hosts close 404 streams — handle silently.
      source = new EventSource(api.stream(), { withCredentials: true });

      const onMessage = () => refreshSoon();
      const onCreated = () => refreshSoon();
      const onRead = () => refreshSoon();
      const onReadAll = () => refreshSoon();
      const onError = () => {
        // silent degrade (leave page usable)
      };

      source.addEventListener("message", onMessage);
      source.addEventListener("created", onCreated);
      source.addEventListener("read", onRead);
      source.addEventListener("read_all", onReadAll);
      source.addEventListener("error", onError as EventListener);

      return () => {
        source?.removeEventListener("message", onMessage);
        source?.removeEventListener("created", onCreated);
        source?.removeEventListener("read", onRead);
        source?.removeEventListener("read_all", onReadAll);
        source?.removeEventListener("error", onError as EventListener);
        source?.close();
        if (refreshTimer.current) {
          clearTimeout(refreshTimer.current);
          refreshTimer.current = null;
        }
      };
    } catch {
      // ignore: no SSE support or endpoint missing
      return () => {
        if (refreshTimer.current) {
          clearTimeout(refreshTimer.current);
          refreshTimer.current = null;
        }
      };
    }
  }, [api, refreshSoon]);

  const markRead = useCallback(
    async (id: number) => {
      // optimistic
      setItems((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
      );
      try {
        const res = await fetch(api.markRead(id), {
          method: "POST",
          credentials: "include",
        });
        if (res.status === 401) {
          handleUnauthorized();
          return;
        }
        if (!res.ok) {
          // revert on failure
          setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: null } : n)));
        }
      } catch {
        // revert on failure
        setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: null } : n)));
      }
    },
    [api, handleUnauthorized]
  );

  const markAll = useCallback(async () => {
    // optimistic: keep items as an array
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? now })));

    try {
      const res = await fetch(api.markAll(), {
        method: "POST",
        credentials: "include",
      });
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        await load(); // server rejected; reload authoritative state
      }
    } catch {
      await load(); // network error; reload
    }
  }, [api, load, handleUnauthorized]);

  const resolveHref = (n: Notification): string | null => {
    const t = (n.type || "").toLowerCase();
    if (t === "creator_request") return "/dashboard";
    if (t === "creator_sale") return "/dashboard";
    if (t === "member_post") return "/purchases";
    if (t === "request_ready") return "/purchases";
    if (t === "membership_renewal") return "/settings";
    if (t === "welcome") return "/";
    return null;
  };

  return (
    <div className="relative overflow-hidden bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 min-h-screen">
      <main className="mx-auto max-w-4xl space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Notifications</h1>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={unreadOnly}
                onChange={(e) => setUnreadOnly(e.target.checked)}
              />
              Unread only
            </label>
              <button
                onClick={markAll}
                className="
                  cursor-pointer rounded-full border px-4 py-1.5 text-sm font-medium
                  bg-white shadow-sm                    /* Default pill + light shadow */
                  hover:bg-neutral-50 hover:shadow-md   /* Desktop hover feedback */
                  active:bg-neutral-100 active:shadow-inner
                  touch:bg-white touch:shadow-sm        /* Touch devices remain white */
                  transition-all duration-150
                "
              >
                Mark all read
              </button>
          </div>
        </div>

        {loading && <div className="text-sm text-neutral-600">Loading…</div>}
        {error && <div className="text-sm text-red-600">{error}</div>}

        {!loading && items.length === 0 && (
          <div className="rounded-2xl border bg-white p-6 text-sm text-neutral-600">
            No notifications yet.
          </div>
        )}

        <ul className="space-y-2">
          {items.map((n) => {
            const href = resolveHref(n);
            const unread = !n.read_at;
            return (
              <li
                key={n.id}
                className={`rounded-2xl border p-3 ${unread ? "bg-red-100" : "bg-white"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="font-medium">
                        {n.title || n.type || "Notification"}
                      </div>
                      {unread && (
                        <span className="h-2 w-2 rounded-full bg-red-600" aria-hidden="true" />
                      )}
                    </div>
                    {n.body && <p className="mt-1 text-sm">{n.body}</p>}
                    <div className="mt-1 text-xs text-neutral-500">
                      {new Date(n.created_at).toLocaleString()}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {href && (
                      <a
                        href={href}
                        className="rounded-xl border px-2.5 py-1 text-xs hover:bg-neutral-50"
                      >
                        Open
                      </a>
                    )}
                    {!n.read_at && (
                      <button
                        onClick={() => markRead(n.id)}
                        className="cursor-pointer text-xs underline"
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
