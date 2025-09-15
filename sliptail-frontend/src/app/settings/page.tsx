"use client";

import { useEffect, useMemo, useState } from "react";

type Prefs = {
  notify_post: boolean;
  notify_membership_expiring: boolean;
  notify_purchase: boolean;
  notify_request_completed: boolean;
  notify_new_request: boolean;
  notify_product_sale: boolean;
};

export default function SettingsPage() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [saving, setSaving] = useState(false);
  const apiBase = useMemo(() => (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, ""), []);

  useEffect(() => {
    (async () => {
      const res = await fetch(`${apiBase}/api/settings/notifications`, { credentials: "include" });
      const data = await res.json();
      setPrefs(data as Prefs);
    })();
  }, [apiBase]);

  async function save() {
    if (!prefs) return;
    setSaving(true);
    await fetch(`${apiBase}/api/settings/notifications`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    });
    setSaving(false);
  }

  if (!prefs) return <main className="max-w-3xl mx-auto p-4">Loading…</main>;

  return (
    <main className="max-w-3xl mx-auto p-4 space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <section className="rounded-2xl border p-4">
        <h2 className="font-semibold mb-3">Notifications</h2>
        <div className="grid gap-2 text-sm">
          {Object.entries(prefs).map(([k, v]) => (
            <label key={k} className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={!!v}
                onChange={(e) => setPrefs((p) => ({ ...(p as Prefs), [k]: e.target.checked }))}
              />
              {k}
            </label>
          ))}
        </div>
        <button onClick={save} disabled={saving} className="mt-3 rounded-xl bg-black text-white py-2 px-4">
          {saving ? "Saving…" : "Save"}
        </button>
      </section>
    </main>
  );
}