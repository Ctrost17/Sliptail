// src/app/creators/[id]/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { useAuth } from "@/components/auth/AuthProvider";
import { fetchApi } from "@/lib/api"; // <-- added

/* -------------------------- Types -------------------------- */

type Product = {
  id: string;
  title: string;
  description?: string | null;
  product_type: "purchase" | "membership" | "request";
  price: number; // cents
};

type CreatorProfile = {
  creator_id: number;
  display_name: string;
  bio: string | null;
  profile_image: string | null;
  average_rating: number;
  products_count: number;
  gallery?: string[];
};

type CategoryChip = { id: number; name: string; slug: string };

type Review = {
  id: string;
  author_name: string;
  rating: number;
  comment: string | null;
  created_at: string; // ISO
  product_title?: string | null;
};

/* ------------------------- Helpers ------------------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function getString(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function getNumber(obj: unknown, key: string): number | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "number" ? v : undefined;
}

function getArray(obj: unknown, key: string): unknown[] | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return Array.isArray(v) ? v : undefined;
}

function toApiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");
}

/** Normalize backend image paths to absolute URLs usable by next/image */
function resolveImageUrl(src: string | null | undefined, apiBase: string): string | null {
  if (!src) return null;
  let s = src.trim();
  if (s.startsWith("//")) s = s.slice(1);
  if (/^https?:\/\//i.test(s)) return s;
  if (!s.startsWith("/")) s = `/${s}`;
  return `${apiBase}${s}`;
}

/* ----------------------- JSON Parsers ----------------------- */

function parseCreatorProfile(json: unknown, fallbackId: string | null): CreatorProfile | null {
  if (!isRecord(json)) return null;

  const idFromUser = getNumber(json, "user_id");
  const idFromCreator = getNumber(json, "creator_id");
  const id = idFromUser ?? idFromCreator ?? (fallbackId ? Number(fallbackId) : Number.NaN);
  if (!Number.isFinite(id)) return null;

  const display_name = getString(json, "display_name") ?? "";
  const bio = ((): string | null => {
    const b = json["bio"];
    return typeof b === "string" ? b : null;
  })();
  const profile_image = ((): string | null => {
    const p = json["profile_image"];
    return typeof p === "string" ? p : null;
  })();
  const average_rating = ((): number => {
    const vNum = getNumber(json, "average_rating");
    if (typeof vNum === "number") return vNum;
    const vStr = getString(json, "average_rating");
    return typeof vStr === "string" ? Number(vStr) || 0 : 0;
  })();
  const products_count = ((): number => {
    const vNum = getNumber(json, "products_count");
    if (typeof vNum === "number") return vNum;
    const vStr = getString(json, "products_count");
    return typeof vStr === "string" ? Number(vStr) || 0 : 0;
  })();
  const gallery = ((): string[] => {
    const arr = json["gallery"];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  })();

  return {
    creator_id: id,
    display_name,
    bio,
    profile_image,
    average_rating,
    products_count,
    gallery,
  };
}

function parseProductItem(x: unknown): Product | null {
  if (!isRecord(x)) return null;

  const id =
    getString(x, "id") ?? (typeof x["id"] === "number" ? String(x["id"]) : undefined);
  if (!id) return null;

  const title = getString(x, "title") ?? "";
  const description = ((): string | null => {
    const d = x["description"];
    return typeof d === "string" ? d : null;
  })();

  const typeRaw = getString(x, "product_type") ?? "purchase";
  const product_type: Product["product_type"] =
    typeRaw === "membership" ? "membership" : typeRaw === "request" ? "request" : "purchase";

  const price = ((): number => {
    const pNum = getNumber(x, "price");
    if (typeof pNum === "number") return pNum;
    const pStr = getString(x, "price");
    return typeof pStr === "string" ? Number(pStr) || 0 : 0;
  })();

  return { id, title, description, product_type, price };
}

function parseProductsResponse(json: unknown): Product[] {
  if (!isRecord(json)) return [];
  const arr = getArray(json, "products");
  if (!arr) return [];
  const out: Product[] = [];
  for (const item of arr) {
    const p = parseProductItem(item);
    if (p) out.push(p);
  }
  return out;
}

function parseCreatorCard(json: unknown): {
  categories: CategoryChip[];
  gallery: string[];
} {
  if (!isRecord(json)) return { categories: [], gallery: [] };

  const front = isRecord(json.front) ? json.front : null;
  const back = isRecord(json.back) ? json.back : null;

  const catsRaw = front ? getArray(front, "categories") ?? [] : [];
  const categories: CategoryChip[] = [];
  for (const c of catsRaw) {
    if (!isRecord(c)) continue;
    const id =
      getNumber(c, "id") ?? (typeof c["id"] === "string" ? Number(c["id"]) : undefined);
    const name = getString(c, "name");
    const slug = getString(c, "slug") ?? "";
    if (typeof id === "number" && Number.isFinite(id) && name) {
      categories.push({ id, name, slug });
    }
  }

  const galRaw = back ? back["gallery"] : [];
  const gallery = Array.isArray(galRaw)
    ? galRaw.filter((x): x is string => typeof x === "string")
    : [];

  return { categories, gallery };
}

function parseReviews(json: unknown): Review[] {
  let arr: unknown[] | undefined;

  if (Array.isArray(json)) {
    arr = json;
  } else if (isRecord(json)) {
    arr = getArray(json, "reviews");
  }

  if (!arr) return [];

  const out: Review[] = [];
  for (const r of arr) {
    if (!isRecord(r)) continue;
    const id =
      getString(r, "id") ??
      (typeof r["id"] === "number" ? String(r["id"]) : undefined) ??
      Math.random().toString(36).slice(2);
    const author_name =
      getString(r, "author_name") ??
      getString(r, "user_name") ??
      getString(r, "username") ??
      "Anonymous";
    const rating = ((): number => {
      const n = getNumber(r, "rating");
      if (typeof n === "number") return n;
      const s = getString(r, "rating");
      return typeof s === "string" ? Number(s) || 0 : 0;
    })();
    const comment = ((): string | null => {
      const cmt = r["comment"] ?? r["text"] ?? r["review"];
      return typeof cmt === "string" ? cmt : null;
    })();
    const created_at =
      getString(r, "created_at") ?? getString(r, "createdAt") ?? new Date().toISOString();

    // NEW: capture product title for display (supports both product_title and title)
    const product_title =
      getString(r, "product_title") ??
      getString(r, "title") ??
      null;

    out.push({ id, author_name, rating, comment, created_at, product_title });
  }
  return out;
}

/* ------------------------- Component ------------------------ */

export default function CreatorProfilePage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const creatorId = params?.id ?? null;

  const apiBase = useMemo(() => toApiBase(), []);
  const router = useRouter();
  const { user, token, loading: authLoading } = useAuth?.() ?? {
    user: null,
    token: null,
    loading: false,
  };

  const [creator, setCreator] = useState<CreatorProfile | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<CategoryChip[]>([]);
  const [gallery, setGallery] = useState<string[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [checkingOutId, setCheckingOutId] = useState<string | null>(null);

  // NEW: track membership subscriptions the viewer currently has
  const [subscribedIds, setSubscribedIds] = useState<Set<number>>(new Set());

  const isOwner =
    !!user &&
    (typeof user.id === "number" ? user.id : Number(user.id)) ===
      (creator?.creator_id ?? Number(creatorId || NaN));

  useEffect(() => {
    if (!creatorId) return;

    const ac = new AbortController();
    let cancelled = false;

    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const profReq = fetch(`${apiBase}/api/creators/${creatorId}`, {
          credentials: "include",
          signal: ac.signal,
        });
        const cardReq = fetch(`${apiBase}/api/creators/${creatorId}/card`, {
          credentials: "include",
          signal: ac.signal,
        });
        const prodReq = fetch(`${apiBase}/api/products/user/${creatorId}`, {
          credentials: "include",
          signal: ac.signal,
        });

        const profRes = await profReq;
        if (!profRes.ok) throw new Error(`HTTP ${profRes.status}`);
        const profJson: unknown = await profRes.json();
        const prof = parseCreatorProfile(profJson, creatorId);
        if (!prof) throw new Error("Invalid profile payload");
        if (cancelled) return;
        setCreator(prof);

        try {
          const res = await cardReq;
          if (res.ok) {
            const cardJson: unknown = await res.json();
            const parsed = parseCreatorCard(cardJson);
            if (!cancelled) {
              setCategories(parsed.categories);
              setGallery(parsed.gallery);
            }
          }
        } catch {}

        try {
          const res = await prodReq;
          if (res.ok) {
            const prodJson: unknown = await res.json();
            const list = parseProductsResponse(prodJson);
            if (!cancelled) setProducts(list);
          } else if (!cancelled) {
            setProducts([]);
          }
        } catch {
          if (!cancelled) setProducts([]);
        }

        try {
          let revs: Review[] = [];
          const r1 = await fetch(`${apiBase}/api/creators/${creatorId}/reviews`, {
            credentials: "include",
            signal: ac.signal,
          });
          if (r1.ok) {
            const j: unknown = await r1.json();
            revs = parseReviews(j);
          } else {
            const r2 = await fetch(`${apiBase}/api/reviews?creatorId=${creatorId}`, {
              credentials: "include",
              signal: ac.signal,
            });
            if (r2.ok) {
              const j2: unknown = await r2.json();
              revs = parseReviews(j2);
            }
          }
          if (!cancelled) setReviews(revs);
        } catch {
          if (!cancelled) setReviews([]);
        }
      } catch {
        if (!cancelled) {
          setErr("Failed to load creator");
          setCreator(null);
          setProducts([]);
          setCategories([]);
          setGallery([]);
          setReviews([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      try {
        ac.abort("route change/unmount");
      } catch {}
    };
  }, [creatorId, apiBase]);

  // NEW: fetch products the viewer is currently subscribed to
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setSubscribedIds(new Set());
        return;
      }
      try {
        const res = await fetchApi<{ products: Array<{ id: number | string }> }>(
          "/api/memberships/subscribed-products",
          { method: "GET", token, cache: "no-store" }
        );
        const set = new Set<number>();
        for (const p of res?.products ?? []) {
          const n =
            typeof p.id === "number"
              ? p.id
              : typeof p.id === "string"
              ? Number(p.id)
              : NaN;
          if (Number.isFinite(n)) set.add(n);
        }
        if (!cancelled) setSubscribedIds(set);
      } catch {
        if (!cancelled) setSubscribedIds(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  /**
   * Client-side checkout:
   * - If not signed in: push to login with next=/creators/:id?checkout=:pid
   * - If signed in: call our server route at /stripe-checkout/start (which forwards cookies and picks the right backend route)
   */
  async function startCheckout(p: Product) {
    if (!creatorId) return;

    // If auth is still hydrating, queue the intent and retry after user loads
    if (authLoading) {
      const selfWithCheckout = `/creators/${encodeURIComponent(String(creatorId))}?checkout=${encodeURIComponent(
        p.id
      )}`;
      router.replace(selfWithCheckout);
      return;
    }

    if (!user) {
      const nextUrl = `/creators/${encodeURIComponent(String(creatorId))}?checkout=${encodeURIComponent(
        p.id
      )}`;
      router.push(`/auth/login?next=${encodeURIComponent(nextUrl)}`);
      return;
    }

    setCheckingOutId(p.id);
    try {
      const mode = p.product_type === "membership" ? "subscription" : "payment";
      const origin = window.location.origin;
      const successUrl = `${origin}/checkout/success?sid={CHECKOUT_SESSION_ID}&pid=${encodeURIComponent(
        p.id
      )}&action=${encodeURIComponent(p.product_type)}`;
      const cancelUrl = `${origin}/checkout/cancel?pid=${encodeURIComponent(
        p.id
      )}&action=${encodeURIComponent(p.product_type)}`;

      const res = await fetch(`${apiBase}/api/stripe-checkout/create-session`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          product_id: Number(p.id) || p.id,
          mode,
          quantity: 1,
          success_url: successUrl,
          cancel_url: cancelUrl,
        }),
      });

      if (res.status === 401 || res.status === 403) {
        const nextUrl = `/creators/${encodeURIComponent(String(creatorId))}?checkout=${encodeURIComponent(
          p.id
        )}`;
        router.push(`/auth/login?next=${encodeURIComponent(nextUrl)}`);
        return;
      }

      if (!res.ok) {
        let msg = "Checkout failed";
        try {
          const j = await res.json();
          msg = (j && (j.error || j.message)) || msg;
        } catch {
          try {
            msg = await res.text();
          } catch {}
        }
        console.error("Checkout error:", msg);
        router.push(
          `/products/${encodeURIComponent(p.id)}?error=${encodeURIComponent(msg || "Checkout failed")}`
        );
        return;
      }

      const data = (await res.json().catch(() => ({}))) as { url?: string };
      if (data?.url) {
        window.location.href = data.url;
        return;
      }

      window.location.href = `/stripe-checkout/start?pid=${encodeURIComponent(
        p.id
      )}&action=${encodeURIComponent(p.product_type)}`;
    } finally {
      setCheckingOutId(null);
    }
  }

  // Auto-start after login if ?checkout=PID
  useEffect(() => {
    const pid = searchParams.get("checkout");
    if (!pid || !user || products.length === 0) return;
    const p = products.find((x) => x.id === pid);
    if (p) void startCheckout(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, user, products]);

  if (!creatorId) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-2xl font-bold">Creator</h1>
        <p className="mt-2 text-sm text-neutral-600">No creator id.</p>
      </main>
    );
  }

  const profileUrl = resolveImageUrl(creator?.profile_image ?? null, apiBase);
  const galleryUrls = (gallery || [])
    .slice(0, 4)
    .map((u) => resolveImageUrl(u, apiBase))
    .filter((u): u is string => !!u);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 space-y-10">
      {loading ? (
        <div className="text-sm text-neutral-600 text-center">Loading…</div>
      ) : err ? (
        <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800 text-center">
          {err}
        </div>
      ) : !creator ? (
        <div className="text-sm text-neutral-600 text-center">Creator not found.</div>
      ) : (
        <>
          {/* Header: centered */}
          <header className="flex flex-col items-center text-center gap-4">
            <div className="relative h-36 w-36 overflow-hidden rounded-full bg-neutral-100">
              {profileUrl ? (
                <Image
                  src={profileUrl}
                  alt={creator.display_name}
                  fill
                  className="object-cover"
                  unoptimized
                  sizes="144px"
                />
              ) : null}
            </div>

            <div>
              <h1 className="text-3xl font-bold">{creator.display_name}</h1>
              <div className="mt-1 text-sm text-neutral-600">
                {Number(creator.average_rating || 0).toFixed(1)} ★ · {creator.products_count} product
                {creator.products_count === 1 ? "" : "s"}
              </div>
            </div>

            {/* Categories under rating */}
            {categories.length > 0 ? (
              <div className="mt-1 flex flex-wrap justify-center gap-2">
                {categories.map((cat) => (
                  <span
                    key={cat.id}
                    className="rounded-full border px-3 py-1 text-xs text-neutral-700"
                    title={cat.name}
                  >
                    {cat.name}
                  </span>
                ))}
              </div>
            ) : null}
          </header>

          {/* About */}
          {creator.bio ? (
            <section className="text-center">
              <h2 className="mb-2 text-lg font-semibold">About</h2>
              <p className="whitespace-pre-line text-neutral-800">{creator.bio}</p>
            </section>
          ) : null}

          {/* Products */}
          <section>
            <h2 className="mb-3 text-lg font-semibold text-center">Products</h2>
            {products.length === 0 ? (
              <div className="text-sm text-neutral-600 text-center">No products yet.</div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {products.map((p) => {
                  const basePriceLabel = `$${((p.price || 0) / 100).toFixed(2)}`;
                  const priceLabel =
                    p.product_type === "membership" ? `${basePriceLabel} per month` : basePriceLabel;

                  // NEW: decide if viewer is already subscribed to THIS membership product
                  const isSubscribed =
                    p.product_type === "membership" &&
                    subscribedIds.has(Number(p.id));

                  let cta = "Purchase download";
                  if (p.product_type === "membership") cta = isSubscribed ? "Currently Subscribed" : "Subscribe for membership";
                  else if (p.product_type === "request") cta = "Purchase request";

                  const ownerCTA = "Edit product";

                  return (
                    <div key={p.id} className="rounded-2xl border p-4 flex flex-col">
                      <div className="text-xs uppercase tracking-wide text-neutral-600">
                        {p.product_type}
                      </div>
                      <div className="font-semibold">{p.title}</div>
                      {p.description ? (
                        <p className="mt-1 text-sm text-neutral-700">{p.description}</p>
                      ) : null}

                      <div className="mt-auto">
                        <div className="mt-2 font-semibold">{priceLabel}</div>

                        {isOwner ? (
                          <button
                            className="mt-3 w-full rounded-xl border py-2"
                            onClick={() => router.push("/dashboard")}
                          >
                            {ownerCTA}
                          </button>
                        ) : (
                          <button
                            className="mt-3 w-full rounded-xl bg-black py-2 text-white hover:bg-black/90 disabled:opacity-60"
                            onClick={() => {
                              if (isSubscribed && p.product_type === "membership") {
                                router.push("/purchases");
                              } else {
                                void startCheckout(p);
                              }
                            }}
                            disabled={checkingOutId === p.id}
                          >
                            {checkingOutId === p.id ? "Redirecting…" : cta}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Photos */}
          {galleryUrls.length > 0 ? (
            <section aria-label="Creator photos">
              <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl">
                <div className="flex">
                  {[0, 1, 2, 3].map((idx) => {
                    const src = galleryUrls[idx];
                    return (
                      <div key={idx} className="relative aspect-[4/3] w-1/4">
                        {src ? (
                          <Image
                            src={src}
                            alt={`${creator.display_name} photo ${idx + 1}`}
                            fill
                            className="object-cover"
                            unoptimized
                            sizes="(max-width: 1280px) 25vw, 320px"
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          ) : null}

          {/* Reviews */}
          {reviews.length > 0 ? (
            <section>
              <h2 className="mb-3 text-lg font-semibold text-center">Reviews</h2>
              <div className="mx-auto max-w-3xl space-y-3">
                {reviews.map((r) => (
                  <div key={r.id} className="rounded-2xl border p-4">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{r.author_name || "Anonymous"}</span>
                      <span className="text-neutral-500">{(r.created_at || "").slice(0, 10)}</span>
                    </div>
                    {/* NEW: show product title when available */}
                    {r.product_title ? (
                      <div className="mt-0.5 text-xs text-neutral-600">
                        Product: {r.product_title}
                      </div>
                    ) : null}
                    <div className="mt-0.5 text-sm">{Number(r.rating || 0).toFixed(1)} ★</div>
                    {r.comment ? <p className="mt-2 text-neutral-800">{r.comment}</p> : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
