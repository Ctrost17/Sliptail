import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type SearchParams = { [key: string]: string | string[] | undefined };

function getString(sp: SearchParams, key: string): string | null {
  const v = sp[key];
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function apiBase(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
    process.env.API_BASE_URL?.replace(/\/$/, "") ||
    "http://localhost:5000"
  );
}

/* ----------------------------- Types & guards ---------------------------- */

type ProductMinimal = {
  id: number | string;
  creator_id?: number | string | null;
  user_id?: number | string | null;
  owner_id?: number | string | null;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function numOrStr(x: unknown): number | string | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "") return x;
  return null;
}

function parseProduct(json: unknown): ProductMinimal | null {
  if (!isRecord(json)) return null;
  const id = numOrStr(json["id"]);
  if (id == null) return null;
  const creator_id = numOrStr(json["creator_id"]);
  const user_id = numOrStr(json["user_id"]);
  const owner_id = numOrStr(json["owner_id"]);
  return { id, creator_id, user_id, owner_id };
}

function toNumber(x: number | string | null | undefined): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && /^\d+$/.test(x)) return Number(x);
  return null;
}

/* --------------------------------- Fetch -------------------------------- */

async function getProduct(pid: string): Promise<ProductMinimal | null> {
  const res = await fetch(`${apiBase()}/api/products/${encodeURIComponent(pid)}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;

  // Avoid explicit `any`: read as unknown, then validate
  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch {
    return null;
  }
  return parseProduct(raw);
}

/* --------------------------------- Page --------------------------------- */

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const pid = getString(searchParams, "pid");
  const action = getString(searchParams, "action"); // purchase | membership | request

  if (!pid) redirect("/");

  const product = await getProduct(pid);
  const creatorId =
    toNumber(product?.creator_id ?? null) ??
    toNumber(product?.user_id ?? null) ??
    toNumber(product?.owner_id ?? null);

  // Prefer redirecting to the creator profile; fallback to product page
  if (creatorId !== null) {
    const q = new URLSearchParams();
    q.set("canceled", "1");
    q.set("pid", pid);
    if (action) q.set("action", action);
    redirect(`/creators/${creatorId}?${q.toString()}`);
  } else {
    const q = new URLSearchParams();
    q.set("canceled", "1");
    if (action) q.set("action", action);
    redirect(`/products/${encodeURIComponent(pid)}?${q.toString()}`);
  }
}