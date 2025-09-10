// src/app/purchases/page.tsx
"use client";

import { useEffect, useState } from "react";
import { fetchApi } from "@/lib/api"; // your helper
// optional: your toast hook
function useToast(){ return { error:(m:string)=>console.error(m), success:(m:string)=>console.log(m) } }

type Order = {
  id: number;
  product_id: number | null;
  amount_cents: number;
  status: string;
  created_at: string;
};

export default function PurchasesPage({ searchParams }: { searchParams: { toast?: string } }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [loading, setLoading] = useState(true);
  const { success, error } = useToast();

  useEffect(() => {
    if (searchParams.toast) success(searchParams.toast);
  }, [searchParams.toast, success]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchApi<Order[]>("/api/orders", {
          // IMPORTANT: see api.ts change below — credentials must be included
          method: "GET",
        });
        if (!cancelled) setOrders(data);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load purchases.";
        error(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [error]);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-bold">Your Purchases</h1>

      {loading && <div className="mt-6 h-2 w-40 animate-pulse rounded bg-green-500/40" />}

      {!loading && orders && orders.length === 0 && (
        <p className="mt-4 text-neutral-600">No purchases yet.</p>
      )}

      {!loading && orders && orders.length > 0 && (
        <ul className="mt-6 space-y-3">
          {orders.map(o => (
            <li key={o.id} className="rounded border p-3">
              <div className="flex items-center justify-between">
                <span>Order #{o.id}</span>
                <span className="font-semibold">${(o.amount_cents/100).toFixed(2)}</span>
              </div>
              <div className="text-sm text-neutral-600">
                {o.status} · {new Date(o.created_at).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
