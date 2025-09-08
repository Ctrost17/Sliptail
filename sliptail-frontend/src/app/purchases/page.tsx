import Link from "next/link";
import { fetchApi } from "@/lib/api";

type Order = {
  id: number;
  status: string;
  created_at: string;
  product: {
    id: number;
    title: string;
    product_type: "purchase" | "membership" | "request";
    price: number; // cents
    view_url?: string;
    download_url?: string;
  };
};

type Membership = {
  id: number;
  creator_id: number;
  product_id: number;
  status: string;
  current_period_end: string;
  has_access: boolean;
  price_cents?: number; // if present
};

type CustomRequest = {
  id: number;
  creator_id: number;
  order_id: number;
  status: string;            // custom request status
  created_at: string;
  order_status: string;      // from join
};

export const revalidate = 0;

async function getOrders() {
  const data = (await fetchApi<{ orders: Order[] }>("/api/orders/mine")) as { orders: Order[] };
  return data?.orders ?? [];
}
async function getMemberships() {
  const data = (await fetchApi<{ memberships: Membership[] }>("/api/memberships/mine")) as { memberships: Membership[] };
  return data?.memberships ?? [];
}
async function getRequests() {
  const data = (await fetchApi<{ requests: CustomRequest[] }>("/api/requests/mine")) as { requests: CustomRequest[] };
  return data?.requests ?? [];
}

export default async function PurchasesPage() {
  const [orders, memberships, requests] = await Promise.all([
    getOrders(),
    getMemberships(),
    getRequests(),
  ]);

  return (
    <main className="max-w-6xl mx-auto p-4 space-y-8">
      <h1 className="text-2xl font-bold">My Purchases</h1>

      {/* Memberships */}
      <section>
        <h2 className="font-semibold mb-2">Memberships</h2>
        <div className="grid gap-3">
          {memberships.length === 0 && <div className="text-sm text-neutral-600">No memberships yet.</div>}
          {memberships.map((m) => (
            <div key={m.id} className="rounded-2xl border p-4 flex items-center justify-between">
              <div>
                <div className="font-medium">Creator #{m.creator_id}</div>
                <div className="text-sm text-neutral-600">
                  {m.status} · access {m.has_access ? "granted" : "inactive"} · renews{" "}
                  {m.current_period_end ? new Date(m.current_period_end).toLocaleDateString() : "—"}
                </div>
              </div>
              <div className="text-sm">
                {typeof m.price_cents === "number" && <span>${(m.price_cents / 100).toFixed(2)}/mo</span>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Custom Requests */}
      <section>
        <h2 className="font-semibold mb-2">Requests</h2>
        <div className="grid gap-3">
          {requests.length === 0 && <div className="text-sm text-neutral-600">No requests yet.</div>}
          {requests.map((r) => (
            <div key={r.id} className="rounded-2xl border p-4">
              <div className="font-medium">Request #{r.id} → Creator #{r.creator_id}</div>
              <div className="text-sm text-neutral-600">
                Request: {r.status} · Order: {r.order_status} · {new Date(r.created_at).toLocaleString()}
              </div>
              <div className="mt-2">
                <Link href={`/requests/${r.id}`} className="text-sm underline">
                  View details
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Digital Purchases */}
      <section>
        <h2 className="font-semibold mb-2">Digital Purchases</h2>
        <div className="grid gap-3">
          {orders.length === 0 && <div className="text-sm text-neutral-600">No purchases yet.</div>}
          {orders.map((o) => (
            <div key={o.id} className="rounded-2xl border p-4 flex items-center justify-between">
              <div>
                <div className="font-medium">{o.product?.title || "Product"}</div>
                <div className="text-sm text-neutral-600">
                  {o.status} · {new Date(o.created_at).toLocaleString()}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="font-semibold">
                  ${((o.product?.price || 0) / 100).toFixed(2)}
                </div>
                {o.product?.view_url && (
                  <a href={o.product.view_url} className="text-sm underline" target="_blank">
                    View
                  </a>
                )}
                {o.product?.download_url && (
                  <a href={o.product.download_url} className="text-sm underline" target="_blank">
                    Download
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
