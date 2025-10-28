// src/app/creators/[id]/page.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { useAuth } from "@/components/auth/AuthProvider";
import { fetchApi } from "@/lib/api";
import { Package, Quote } from "lucide-react";

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
function formatDate(d?: string | null) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return d || "";
  }
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

  return { creator_id: id, display_name, bio, profile_image, average_rating, products_count, gallery };
}

function parseProductItem(x: unknown): Product | null {
  if (!isRecord(x)) return null;

  const id = getString(x, "id") ?? (typeof x["id"] === "number" ? String(x["id"]) : undefined);
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
function parseCreatorCard(json: unknown): { categories: CategoryChip[]; gallery: string[] } {
  if (!isRecord(json)) return { categories: [], gallery: [] };
  const front = isRecord(json.front) ? json.front : null;
  const back = isRecord(json.back) ? json.back : null;

  const catsRaw = front ? getArray(front, "categories") ?? [] : [];
  const categories: CategoryChip[] = [];
  for (const c of catsRaw) {
    if (!isRecord(c)) continue;
    const id = getNumber(c, "id") ?? (typeof c["id"] === "string" ? Number(c["id"]) : undefined);
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
  if (Array.isArray(json)) arr = json;
  else if (isRecord(json)) arr = getArray(json, "reviews");
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
    const created_at = getString(r, "created_at") ?? getString(r, "createdAt") ?? new Date().toISOString();
    const product_title = getString(r, "product_title") ?? getString(r, "title") ?? null;
    out.push({ id, author_name, rating, comment, created_at, product_title });
  }
  return out;
}

/* ------------------------------ UI bits ------------------------------ */

function StarsRow({ value, size = "text-sm" }: { value: number; size?: string }) {
  const clamped = Math.max(0, Math.min(5, value));
  const full = Math.floor(clamped);
  const half = clamped - full >= 0.5;
  return (
    <div className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => {
        const active = i < full || (i === full && half);
        return (
          <span key={i} className={`${size} ${active ? "text-yellow-400" : "text-gray-300"}`} aria-hidden>
            ★
          </span>
        );
      })}
    </div>
  );
}

/** Expandable product description */
function ExpandableText({
  text,
  initialChars = 280,
}: {
  text: string;
  initialChars?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsToggle = text.length > initialChars;
  const visible = expanded || !needsToggle ? text : text.slice(0, initialChars) + "…";

  return (
    <div className="mt-1 text-sm text-gray-700">
      <p className="whitespace-pre-wrap">{visible}</p>
      {needsToggle && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-gray-900 underline underline-offset-2 hover:text-black cursor-pointer"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/* ------------------------- Component ------------------------ */

export default function CreatorProfilePage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const creatorId = params?.id ?? null;

  const apiBase = useMemo(() => toApiBase(), []);
  const router = useRouter();
  const { user, token, loading: authLoading } = useAuth?.() ?? { user: null, token: null, loading: false };

  const [creator, setCreator] = useState<CreatorProfile | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<CategoryChip[]>([]);
  const [gallery, setGallery] = useState<string[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [checkingOutId, setCheckingOutId] = useState<string | null>(null);

  // Subscriptions state
  const [subscribedIds, setSubscribedIds] = useState<Set<number>>(new Set());
  const [subsReady, setSubsReady] = useState(false); // <-- NEW: know when subscribedIds is loaded

  // --- Smart, resolution-aware avatar (auto-sizes the circle; no crop/zoom) ---
  const [avatarPx, setAvatarPx] = useState(225); // start ~11rem to avoid layout shift
  const [naturalDims, setNaturalDims] = useState<{ w: number; h: number } | null>(null);

  function computeAvatarSize(nw: number, nh: number) {
    const dpr = typeof window !== "undefined" ? Math.max(1, window.devicePixelRatio || 1) : 1;

    // Prefer a big avatar, scale a bit with viewport (desktop > tablet > phone)
     let base = 224; // ~14rem default
  if (typeof window !== "undefined") {
    const vw = window.innerWidth;
    if (vw >= 1280) base = 288;      // ~18rem on large desktops
    else if (vw >= 1024) base = 256; // ~16rem on desktops
    else if (vw >= 640)  base = 208; // ~13rem on tablets
    else                 base = 176; // ~11rem on phones
  }

    // Don't upscale beyond the smallest natural dimension / DPR (prevents blur).
    const safeMax = Math.max(128, Math.floor(Math.min(nw, nh) / dpr));

    // Allow up to ~15% gentle upscale so tiny-but-hires images don't look too small
    const allowed = Math.min(base, Math.floor(safeMax * 1.35));

    // Ensure it's still "somewhat big"

    setAvatarPx(allowed);
  }

  function handleAvatarLoaded(img: HTMLImageElement) {
    const nw = img.naturalWidth || 1;
    const nh = img.naturalHeight || 1;
    setNaturalDims({ w: nw, h: nh });
    computeAvatarSize(nw, nh);
  }

  // Recompute avatar size on resize to keep it nice across widths
  useEffect(() => {
    if (!naturalDims) return;
    const onResize = () => computeAvatarSize(naturalDims.w, naturalDims.h);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [naturalDims]);

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
        const profReq = fetch(`${apiBase}/api/creators/${creatorId}`, { credentials: "include", signal: ac.signal });
        const cardReq = fetch(`${apiBase}/api/creators/${creatorId}/card`, { credentials: "include", signal: ac.signal });
        const prodReq = fetch(`${apiBase}/api/products/user/${creatorId}`, { credentials: "include", signal: ac.signal });

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

  // Fetch products the viewer is subscribed to (for membership CTA state)
  useEffect(() => {
    let cancelled = false;
    setSubsReady(false);
    (async () => {
      if (!token) {
        setSubscribedIds(new Set());
        setSubsReady(true);
        return;
      }
      try {
        const res = await fetchApi<{ products: Array<{ id: number | string }> }>(
          "/api/memberships/subscribed-products",
          { method: "GET", token, cache: "no-store" }
        );
        const set = new Set<number>();
        for (const p of res?.products ?? []) {
          const n = typeof p.id === "number" ? p.id : typeof p.id === "string" ? Number(p.id) : NaN;
          if (Number.isFinite(n)) set.add(n);
        }
        if (!cancelled) setSubscribedIds(set);
      } catch {
        if (!cancelled) setSubscribedIds(new Set());
      } finally {
        if (!cancelled) setSubsReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Checkout handler (guard against already-subscribed membership)
  async function startCheckout(p: Product) {
    if (!creatorId) return;

    if (p.product_type === "membership" && subscribedIds.has(Number(p.id))) {
      router.push("/purchases");
      return;
    }

    if (authLoading) {
      const selfWithCheckout = `/creators/${encodeURIComponent(String(creatorId))}?checkout=${encodeURIComponent(p.id)}`;
      router.replace(selfWithCheckout);
      return;
    }
    if (!user) {
      const nextUrl = `/creators/${encodeURIComponent(String(creatorId))}?checkout=${encodeURIComponent(p.id)}`;
      router.push(`/auth/login?next=${encodeURIComponent(nextUrl)}`);
      return;
    }

    setCheckingOutId(p.id);
    try {
      const mode = p.product_type === "membership" ? "subscription" : "payment";
      const origin = window.location.origin;
      const successUrl = `${origin}/checkout/success?sid={CHECKOUT_SESSION_ID}&pid=${encodeURIComponent(p.id)}&action=${encodeURIComponent(p.product_type)}`;
      const cancelUrl = `${origin}/checkout/cancel?pid=${encodeURIComponent(p.id)}&action=${encodeURIComponent(p.product_type)}`;

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
        const nextUrl = `/creators/${encodeURIComponent(String(creatorId))}?checkout=${encodeURIComponent(p.id)}`;
        router.push(`/auth/login?next=${encodeURIComponent(nextUrl)}`);
        return;
      }

      if (!res.ok) {
        let msg = "Checkout failed";
        try {
          const j = await res.json();
          msg = (j && (j.error || j.message)) || msg;
        } catch {
          try { msg = await res.text(); } catch {}
        }
        router.push(`/products/${encodeURIComponent(p.id)}?error=${encodeURIComponent(msg || "Checkout failed")}`);
        return;
      }

      const data = (await res.json().catch(() => ({}))) as { url?: string };
      if (data?.url) {
        window.location.href = data.url;
        return;
      }
      window.location.href = `/stripe-checkout/start?pid=${encodeURIComponent(p.id)}&action=${encodeURIComponent(p.product_type)}`;
    } finally {
      setCheckingOutId(null);
    }
  }

  // Auto-start after login if ?checkout=PID (wait for subsReady, and guard for already-subscribed)
  useEffect(() => {
    const pid = searchParams.get("checkout");
    if (!pid || !user || products.length === 0 || !subsReady) return;
    const p = products.find((x) => x.id === pid);
    if (!p) return;

    if (p.product_type === "membership" && subscribedIds.has(Number(p.id))) {
      router.replace(`/creators/${encodeURIComponent(String(params?.id || ""))}`);
      router.push("/purchases");
      return;
    }

    void startCheckout(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, user, products, subsReady, subscribedIds]);

  if (!creatorId) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-10">
        <h1 className="text-2xl font-bold">Creator</h1>
        <p className="mt-2 text-sm text-neutral-600">No creator id.</p>
      </main>
    );
  }

  const profileUrl = resolveImageUrl(creator?.profile_image ?? null, apiBase);
  const galleryUrls = (gallery || []).slice(0, 4).map((u) => resolveImageUrl(u, apiBase)).filter((u): u is string => !!u);
  const avg = Math.max(0, Math.min(5, Number(creator?.average_rating || 0)));
  const productCount = Number(creator?.products_count || 0);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero */}
    <section className="relative overflow-visible">
      {/* background behind content */}
      <div className="absolute inset-0 z-0 bg-gradient-to-tr from-emerald-300 via-cyan-400 to-sky-400 opacity-90" />
      {/* content above wave + more bottom padding + min height */}
      <div className="relative z-10 mx-auto max-w-6xl px-4 pt-12 sm:pt-14 lg:pt-16 pb-32 sm:pb-36 lg:pb-48 min-h-[380px] sm:min-h-[440px] lg:min-h-[520px]">
          <div className="flex flex-col items-center text-center">
            <div
              className="relative rounded-full overflow-hidden ring-4 ring-white shadow-xl bg-neutral-200"
              style={{ width: avatarPx, height: avatarPx }}
            >
              {profileUrl ? (
                <Image
                  src={profileUrl}
                  alt={creator?.display_name || "Creator"}
                  fill
                  className="object-cover object-center"
                  priority
                  quality={92}
                  sizes={`${Math.ceil(avatarPx)}px`}
                  onLoadingComplete={handleAvatarLoaded}
                  style={{ imageOrientation: "from-image" as any }}
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center bg-gray-200 text-gray-500">
                  No Image
                </div>
              )}
            </div>

            <h1 className="mt-4 text-2xl sm:text-3xl font-bold text-black">{creator?.display_name}</h1>

            {/* Stats pills (gallery count pill removed) */}
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-sm text-gray-800 shadow">
                <StarsRow value={avg} />
                <span className="ml-1 font-medium">{avg.toFixed(1)}</span>
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-sm text-gray-800 shadow">
                <Package className="h-4 w-4" />
                <span className="font-medium">{productCount}</span>
                <span className="text-gray-500">products</span>
              </span>
            </div>

            {/* Categories */}
            {categories.length > 0 && (
              <div className="mt-5 lg:mt-6 flex flex-wrap items-center justify-center gap-2">
                {categories.map((c) => (
                    <span
                      key={c.id}
                      className="
                        rounded-full border border-black/20 bg-white/90
                        px-4 lg:px-5 py-1.5 lg:py-2
                        text-sm lg:text-base font-medium text-gray-800
                        shadow backdrop-blur-sm
                      "
                      title={c.name}
                    >
                    {c.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
          {/* Decorative curve (behind content) */}
          <svg
            className="absolute bottom-0 left-0 right-0 z-0 pointer-events-none"
            viewBox="0 0 1440 110"
            fill="none"
            preserveAspectRatio="none"
          >
          <path d="M0 0h1440v56c-224 40-448 60-720 54S224 78 0 56V0Z" className="fill-gray-50" />
        </svg>
      </section>

      {/* Body */}
      <main className="relative mx-auto max-w-6xl px-4 -mt-12 sm:-mt-16 lg:-mt-20 space-y-10 pb-12 sm:pb-16 lg:pb-20">
        {/* About */}
        {creator?.bio ? (
          <section className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-6 sm:p-8">
            <h2 className="text-lg font-semibold">About</h2>
            <p className="mt-3 whitespace-pre-wrap text-gray-700">{creator.bio}</p>
          </section>
        ) : null}

        {/* Products */}
        <section className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-6 sm:p-8">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Products</h2>
            <div className="text-sm text-gray-500">{productCount} total</div>
          </div>

          {products.length === 0 ? (
            <p className="mt-4 text-gray-600">No products yet.</p>
          ) : (
            <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {products.map((p) => {
                const basePriceLabel = `$${((p.price || 0) / 100).toFixed(2)}`;
                const priceLabel = p.product_type === "membership" ? `${basePriceLabel} / month` : basePriceLabel;
                const isSubscribed = p.product_type === "membership" && subscribedIds.has(Number(p.id));
                let cta = "Purchase download";
                if (p.product_type === "membership") cta = isSubscribed ? "Currently Subscribed" : "Subscribe for membership";
                else if (p.product_type === "request") cta = "Purchase request";

                return (
                  <div key={p.id} className="group overflow-hidden rounded-2xl ring-1 ring-black/5 bg-white hover:shadow-md transition flex flex-col">
                    {/* Header visual: brand gradient + darker text */}
                    <div className="aspect-[16/9] bg-gradient-to-br from-emerald-200 via-cyan-200 to-sky-200 grid place-items-center">
                      <div className="flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-black/80 shadow-sm">
                        <Package className="h-5 w-5 text-black/70" />
                        <span className="text-xs font-semibold uppercase tracking-wide">{p.product_type}</span>
                      </div>
                    </div>

                    <div className="p-4 flex-1 flex flex-col">
                      <h3 className="font-semibold text-gray-900">{p.title}</h3>

                      {/* Expandable description */}
                      {p.description && <ExpandableText text={p.description} initialChars={280} />}

                      <div className="mt-auto">
                        <div className="mt-3 font-semibold">{priceLabel}</div>
                        {isOwner ? (
                          <button
                            className="mt-3 w-full rounded-xl cursor-pointer border py-2 text-sm hover:bg-gray-50"
                            onClick={() => router.push("/dashboard")}
                          >
                            Edit product
                          </button>
                        ) : (
                          <button
                            className={`mt-3 w-full rounded-xl px-4 py-2 text-sm font-medium transition
                              ${isSubscribed && p.product_type === "membership"
                                ? "bg-gray-200 text-gray-700 cursor-pointer"
                                : "bg-gray-900 text-white hover:bg-black/90 cursor-pointer"}`}
                            onClick={() => {
                              if (isSubscribed && p.product_type === "membership") router.push("/purchases");
                              else void startCheckout(p);
                            }}
                            disabled={checkingOutId === p.id}
                          >
                            {checkingOutId === p.id ? "Redirecting…" : cta}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Gallery (4) */}
      {galleryUrls.length > 0 ? (
        <section className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-6 sm:p-8">
          <h2 className="text-lg font-semibold">Gallery</h2>

          {/* Masonry columns: keeps each image’s natural height, responsive, no horizontal scroll */}
          <div className="mt-5 columns-2 sm:columns-3 lg:columns-4 [column-gap:0.75rem] [column-fill:_balance]">
            {galleryUrls.slice(0, 12).map((src, i) => (
              <div
                key={`${src}-${i}`}
                className="mb-3 break-inside-avoid rounded-xl ring-1 ring-black/5 overflow-hidden bg-gray-100"
              >
                <Image
                  src={src}
                  alt={`Gallery ${i + 1}`}
                  width={1200}
                  height={1600}
                  // Fixed column width at each breakpoint; height grows to match the photo
                  sizes="(min-width:1280px) 272px, (min-width:1024px) 320px, (min-width:640px) 320px, 90vw"
                  style={{ width: "100%", height: "auto", display: "block" }}
                  quality={90}
                  loading={i === 0 ? "eager" : "lazy"}
                  priority={i === 0}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}

        {/* Reviews */}
        <section className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Reviews</h2>
              <div className="mt-1 flex items-center gap-2 text-gray-700">
                <StarsRow value={avg} />
                <span className="text-sm font-medium">{avg.toFixed(1)} average</span>
              </div>
            </div>
          </div>

          {reviews.length === 0 ? (
            <p className="mt-4 text-gray-600">No reviews yet.</p>
          ) : (
            <div className="mt-6 space-y-4">
              {reviews.map((r) => (
                <div key={r.id} className="rounded-xl ring-1 ring-black/5 p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <StarsRow value={Math.max(0, Math.min(5, Number(r.rating) || 0))} />
                      <span className="text-xs text-gray-500">{formatDate(r.created_at)}</span>
                    </div>
                    <div className="text-xs text-gray-500">
                      by <span className="font-medium text-gray-700">{r.author_name || "Anonymous"}</span>
                    </div>
                  </div>

                  {r.product_title ? (
                    <div className="mt-1 text-xs text-gray-500 flex items-center gap-1">
                      <Package className="h-3 w-3" />
                      <span>Product: {r.product_title}</span>
                    </div>
                  ) : null}

                  {r.comment && (
                    <div className="mt-3 flex gap-2 text-gray-700">
                      <Quote className="h-4 w-4 mt-1 shrink-0 text-gray-300" />
                      <p className="whitespace-pre-wrap">{r.comment}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* Loading / Error toasts */}
      {loading && (
        <div className="fixed inset-x-0 bottom-4 z-10 mx-auto w-fit rounded-full bg-gray-900 text-white px-4 py-2 text-sm shadow">
          Loading creator…
        </div>
      )}
      {err && (
        <div className="fixed inset-x-0 bottom-4 z-10 mx-auto w-fit rounded-full bg-red-600 text-white px-4 py-2 text-sm shadow">
          {err}
        </div>
      )}
    </div>
  );
}
