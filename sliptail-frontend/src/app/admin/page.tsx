"use client";

import { useEffect, useMemo, useState, useCallback } from "react";

type Category = { id: number; name: string; slug?: string | null };
type User = { id: number; email: string; role: string; is_active?: boolean };

export default function AdminPage() {
  const apiBase = useMemo(() => (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, ""), []);
  const [cats, setCats] = useState<Category[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [newCat, setNewCat] = useState("");

  const load = useCallback(async () => {
    // categories (public list)
    const c = await fetch(`${apiBase}/api/categories`, { credentials: "include" }).then((r) => r.json());
    setCats(c?.categories ?? c ?? []);

    // users (admin)
    const u = await fetch(`${apiBase}/api/admin/users`, { credentials: "include" }).then((r) => r.json());
    setUsers(u?.users ?? u ?? []);
  }, [apiBase]);

  useEffect(() => {
    load();
  }, [load]);

  const addCategory = useCallback(async () => {
    if (!newCat.trim()) return;
    await fetch(`${apiBase}/api/admin/categories`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newCat }),
    });
    setNewCat("");
    await load();
  }, [apiBase, newCat, load]);

  const deleteCategory = useCallback(async (id: number) => {
    await fetch(`${apiBase}/api/admin/categories/${id}`, { method: "DELETE", credentials: "include" });
    await load();
  }, [apiBase, load]);

  const featureCreator = useCallback(async (id: number, feature = true) => {
    await fetch(`${apiBase}/api/admin/creators/${id}/${feature ? "feature" : "unfeature"}`, {
      method: "POST",
      credentials: "include",
    });
    alert(`${feature ? "Featured" : "Unfeatured"} creator ${id}`);
  }, [apiBase]);

  const toggleUser = useCallback(async (id: number, active: boolean) => {
    await fetch(`${apiBase}/api/admin/users/${id}/${active ? "deactivate" : "reactivate"}`, {
      method: "POST",
      credentials: "include",
    });
    await load();
  }, [apiBase, load]);

  return (
    <main className="max-w-6xl mx-auto p-4 space-y-6">
      <h1 className="text-2xl font-bold">Admin Portal</h1>

      <section className="rounded-2xl border p-4">
        <h2 className="font-semibold mb-3">Categories</h2>
        <div className="flex gap-2">
          <input
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            placeholder="New category"
            className="rounded-xl border px-3 py-2"
          />
          <button onClick={addCategory} className="rounded-xl border px-3">Add</button>
        </div>
        <ul className="mt-3 text-sm space-y-1">
          {cats.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-lg border p-2">
              <span>{c.name}</span>
              <button onClick={() => deleteCategory(c.id)} className="text-sm underline">Delete</button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border p-4">
        <h2 className="font-semibold mb-3">Feature Creator</h2>
        <div className="text-sm">Use the buttons on a creator’s card/profile in your admin tooling, or paste an ID here temporarily:</div>
        <div className="mt-2 flex gap-2">
          <input id="creatorId" placeholder="Creator user_id" className="rounded-xl border px-3 py-2" />
          <button
            onClick={() => {
              const id = Number((document.getElementById("creatorId") as HTMLInputElement).value);
              if (id) featureCreator(id, true);
            }}
            className="rounded-xl border px-3"
          >
            Feature
          </button>
          <button
            onClick={() => {
              const id = Number((document.getElementById("creatorId") as HTMLInputElement).value);
              if (id) featureCreator(id, false);
            }}
            className="rounded-xl border px-3"
          >
            Unfeature
          </button>
        </div>
      </section>

      <section className="rounded-2xl border p-4">
        <h2 className="font-semibold mb-3">Users</h2>
        <div className="text-sm opacity-70 mb-2">Deactivate/reactivate accounts</div>
        <ul className="space-y-1">
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between rounded-lg border p-2">
              <span className="text-sm">{u.email} · {u.role}</span>
              <button onClick={() => toggleUser(u.id, !!u.is_active)} className="text-sm underline">
                {u.is_active ? "Deactivate" : "Reactivate"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}