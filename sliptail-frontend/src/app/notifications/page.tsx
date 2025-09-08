"use client";

import { useEffect, useMemo, useState, useCallback } from "react";

type Notification = {
  id: number;
  title: string | null;
  body: string | null;
  type: string | null;
  metadata?: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const apiBase = useMemo(
    () => (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, ""),
    []
  );

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(
      `${apiBase}/api/notifications?limit=50&offset=0&unread_only=${unreadOnly}`,
      { credentials: "include" }
    );
    const data = await res.json();
    setItems(data?.notifications ?? []);
    setLoading(false);
  }, [apiBase, unreadOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const markRead = useCallback(
    async (id: number) => {
      await fetch(`${apiBase}/api/notifications/${id}/read`, {
        method: "POST",
        credentials: "include",
      });
      setItems((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
      );
    },
    [apiBase]
  );

  const markAll = useCallback(async () => {
    await fetch(`${apiBase}/api/notifications/read-all`, {
      method: "POST",
      credentials: "include",
    });
    setItems((prev) => prev.map((n) => ({ ...n, read_at: new Date().toISOString() })));
  }, [apiBase]);

  return (
    <main className="max-w-4xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Notifications</h1>
        <div className="flex items-center gap-2">
          <label className="text-sm flex items-center gap-1">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
            />
            Unread only
          </label>
          <button onClick={markAll} className="rounded-lg border px-3 py-1 text-sm">
            Mark all read
          </button>
        </div>
      </div>

      {loading && <div className="text-sm text-neutral-600">Loading…</div>}

      <ul className="space-y-2">
        {items.map((n) => (
          <li key={n.id} className="rounded-2xl border p-3">
            <div className="flex items-center justify-between">
              <div className="font-medium">{n.title || n.type || "Notification"}</div>
              {!n.read_at && (
                <button onClick={() => markRead(n.id)} className="text-sm underline">
                  Mark read
                </button>
              )}
            </div>
            {n.body && <p className="text-sm mt-1">{n.body}</p>}
            <div className="text-xs text-neutral-500 mt-1">
              {new Date(n.created_at).toLocaleString()}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}