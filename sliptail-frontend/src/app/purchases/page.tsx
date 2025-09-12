// src/app/purchases/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchApi } from "@/lib/api"; // your helper
import { loadAuth } from "@/lib/auth";
// optional: your toast hook
function useToast(){
  return {
    showError: (m: string) => console.error(m),
    showSuccess: (m: string) => console.log(m),
  };
}

type Order = {
  id: number;
  product_id: number | null;
  amount_cents: number;
  status: string;
  created_at: string;
};

export default function PurchasesPage() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [loading, setLoading] = useState(true);
  const { showSuccess, showError } = useToast();
  const searchParams = useSearchParams();
  const toast = searchParams.get("toast");

  useEffect(() => {
    if (toast) showSuccess(toast);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { token } = loadAuth();
        const legacy = await fetchApi<{ orders: any[] }>("/api/orders/mine", {
          method: "GET",
          token,
          cache: "no-store",
        });
        const mapped: Order[] = (legacy?.orders || []).map((o: any) => ({
          id: Number(o.id),
          product_id: o.product_id ?? (o.product?.id ?? null),
          amount_cents:
            typeof o.amount_cents === "number"
              ? o.amount_cents
              : typeof o.amount === "number"
              ? Math.round(o.amount * 100)
              : 0,
          status: String(o.status ?? "unknown"),
          created_at: String(o.created_at ?? new Date().toISOString()),
        }));
        if (!cancelled) setOrders(mapped);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load purchases.";
        showError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
