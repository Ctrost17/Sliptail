// src/app/dashboard/page.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { loadAuth } from "@/lib/auth";

/* ----------------------------- Types ----------------------------- */
type Product = {
  id: string;
  title: string;
  description?: string | null;
  product_type: "purchase" | "membership" | "request";
  price: number;
};

type CreatorProfile = {
  creator_id: number;
  display_name: string;
  bio: string | null;
  profile_image: string | null;
  average_rating: number;
  products_count: number;
};
type GalleryPhoto = { position: number; url: string | null };
type CategoryItem = { id: string; name: string };

type Review = {
  id: string;
  rating: number;
  comment: string;
  buyer_id: number;
  created_at: string;
  product: {
      description: string | null;
      view_url: string | null;
      download_url: string | null;
      product_type: string;
      title: string;
      filename: string;
  };
};

// Enhanced review type
type ReviewExtended = Review & {
  buyer?: { id?: number; username?: string | null; email?: string | null } | null;
  product_id?: string | null;
};

/* -------------------------- Safe helpers -------------------------- */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function getStringProp(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}
function getBooleanProp(obj: unknown, key: string): boolean | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "boolean" ? v : undefined;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function getStringArrayProp(obj: unknown, key: string): string[] | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return isStringArray(v) ? v : undefined;
}
function toCategoryItem(input: unknown): CategoryItem | null {
  const maybeStr = asString(input);
  if (maybeStr) return { id: maybeStr, name: maybeStr };
  if (isRecord(input)) {
    const name =
      getStringProp(input, "name") ??
      getStringProp(input, "category") ??
      getStringProp(input, "label") ??
      getStringProp(input, "title");
    if (!name) return null;
    const id =
      getStringProp(input, "id") ??
      getStringProp(input, "category_id") ??
      getStringProp(input, "slug") ??
      getStringProp(input, "value") ??
      name;
    return { id: id || name, name };
  }
  return null;
}
function toCategoryItemsFlexible(payload: unknown): CategoryItem[] {
  if (Array.isArray(payload)) {
    return payload.map(toCategoryItem).filter((x): x is CategoryItem => x !== null);
  }
  if (isRecord(payload)) {
    const keys = ["categories", "data", "items", "results"];
    for (const k of keys) {
      const v = (payload as Record<string, unknown>)[k];
      if (Array.isArray(v)) {
        return v.map(toCategoryItem).filter((x): x is CategoryItem => x !== null);
      }
    }
    const entries = Object.entries(payload);
    if (entries.length > 0 && entries.every(([k]) => typeof k === "string")) {
      return entries.map(([k]) => ({ id: String(k), name: String(k) }));
    }
  }
  return [];
}
function uniqStrings(list: string[]): string[] {
  const set = new Set<string>();
  for (const s of list) set.add(s);
  return Array.from(set);
}
function extractMessage(obj: unknown, fallback: string): string {
  return getStringProp(obj, "error") || getStringProp(obj, "message") || fallback;
}
function buildAuthHeaders(extra?: Record<string, string>): HeadersInit {
  let token: string | null = null;
  try {
    token = loadAuth()?.token ?? null;
  } catch {
    token = null;
  }
  return {
    ...(extra || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
function resolveImageUrl(src: string | null | undefined, apiBase: string): string | null {
  if (!src) return null;
  let s = src.trim();
  if (s.startsWith("//")) s = s.slice(1);
  if (/^https?:\/\//i.test(s)) return s;
  if (!s.startsWith("/")) s = `/${s}`;
  return `${apiBase}${s}`;
}
function isLikelyImage(url: string) {
  const clean = url.split("?")[0].toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/.test(clean);
}
function isLikelyVideo(url: string) {
  const clean = url.split("?")[0].toLowerCase();
  return /\.(mp4|m4v|mov|webm|avi|mkv)$/.test(clean);
}
function isLikelyAudio(url: string) {
  const clean = url.split("?")[0].toLowerCase();
  return /\.(mp3|wav|m4a|aac|ogg|webm)$/.test(clean);
}
function AttachmentViewer({
  src,
  className = "w-full rounded-lg border overflow-hidden bg-black/5",
}: { src: string; className?: string }) {
  if (isLikelyImage(src)) {
    return <img src={src} alt="attachment" className={`${className} object-contain`} />;
  }
  if (isLikelyVideo(src)) {
    return (
      <video
        src={src}
        controls
        playsInline
        preload="metadata"
        className={`${className} aspect-video`}
      />
    );
  }
    if (isLikelyAudio(src)) {
    return (
      <audio
        src={src}
        controls
        preload="metadata"
        className={`${className} w-full`}
      />
    );
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
      Open attachment
    </a>
  );
}

function LocalAttachmentPreview({ file, url }: { file: File | null; url: string | null }) {
  if (!file || !url) return null;

  const mime = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();

  const isVideo = mime.startsWith("video/") || /\.(mp4|webm|ogg|m4v|mov)$/.test(name);
  const isAudio = mime.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|webm)$/.test(name);
  const isImage = mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg)$/.test(name);

  if (isAudio) {
    return <audio src={url} controls preload="metadata" className="block w-full bg-black" />;
  }
  if (isVideo) {
    return (
      <video
        src={url}
        controls
        playsInline
        preload="metadata"
        className="block w-full h-auto max-h-[60vh] object-contain bg-black"
      />
    );
  }
  if (isImage) {
    return <img src={url} alt="preview" className="block w-full h-auto object-contain bg-black" />;
  }
  return <div className="text-sm text-neutral-700">{file.name}</div>;
}


/* ----------------------- Small UI helpers ----------------------- */
function StarRating({ value, size = 16 }: { value: number; size?: number }) {
  const pct = Math.max(0, Math.min(5, Number(value || 0))) / 5 * 100;
  return (
    <div className="relative inline-flex" aria-label={`${value.toFixed(1)} out of 5`}>
      <div className="text-neutral-300" style={{ fontSize: size }}>
        {"★★★★★"}
      </div>
      <div
        className="absolute left-0 top-0 overflow-hidden text-yellow-500"
        style={{ width: `${pct}%`, fontSize: size }}
      >
        {"★★★★★"}
      </div>
    </div>
  );
}

/* ------------------------------ Component ------------------------------ */
export default function DashboardPage() {
  const router = useRouter();
  const { user } = useAuth?.() ?? { user: null };

  const token = loadAuth()?.token ?? null;

  useEffect(() => {
    (async () => {
      try {
        await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000"}/api/me`, {
          credentials: "include",
          headers: buildAuthHeaders(),
        });
      } catch (error) {
        console.error("Error checking auth:", error);
      }
    })();
  }, []);

  const apiBase = useMemo(
    () => (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, ""),
    []
  );
  const creatorId = user?.id ? String(user.id) : null;

  /* ---------------- Pending requests ---------------- */
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);

  const loadPending = useCallback(async () => {
    if (!creatorId) return;
    setPendingLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/requests/inbox?status=pending`, {
        credentials: "include",
        headers: buildAuthHeaders(),
      });
      if (!res.ok) throw new Error("Failed to load pending requests");
      const data: unknown = await res.json();
      let list: any[] = [];
      if (Array.isArray((data as any)?.requests)) list = (data as any).requests;
      else if (Array.isArray(data)) list = data as any[];
      setPendingRequests(list);
    } catch (e) {
      console.error("Failed to load pending requests:", e);
      setPendingRequests([]);
    } finally {
      setPendingLoading(false);
    }
  }, [creatorId, apiBase]);

  useEffect(() => {
    if (!creatorId) return;
    loadPending();
  }, [creatorId, loadPending]);

  /* ---------------- Creator/profile/products ---------------- */
  const [creator, setCreator] = useState<CreatorProfile | null>(null);
  const [gallery, setGallery] = useState<GalleryPhoto[]>([
    { position: 1, url: null },
    { position: 2, url: null },
    { position: 3, url: null },
    { position: 4, url: null },
  ]);
  const profileImgInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRefs = [
    useRef<HTMLInputElement | null>(null),
    useRef<HTMLInputElement | null>(null),
    useRef<HTMLInputElement | null>(null),
    useRef<HTMLInputElement | null>(null),
  ];
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const hasMembership = useMemo(() => products.some((p) => p.product_type === "membership"), [products]);

  // Reviews state
  const [reviewsMap, setReviewsMap] = useState<Record<
    string,
    { items: ReviewExtended[]; page: number; hasMore: boolean; loading: boolean }
  >>({});
  const [activeReviewsProduct, setActiveReviewsProduct] = useState<string | null>(null);

  // Quick edit state
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [savingProfile, setSavingProfile] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // Categories
  const [allCategories, setAllCategories] = useState<CategoryItem[]>([]);
  const [catsLoading, setCatsLoading] = useState(false);
  const catsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const catsInitializedRef = useRef(false);

  // Stripe
  const [connecting, setConnecting] = useState(false);
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeConnected, setStripeConnected] = useState<boolean | null>(null);

  // Delete product
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // Toast
  const [toastOpen, setToastOpen] = useState(false);
  const [toastText, setToastText] = useState<string>("");
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Average rating (force fresh)
  const [averageRating, setAverageRating] = useState<number | null>(null);

  // Request modals
  const [activeRequest, setActiveRequest] = useState<any | null>(null);
  function openRequest(req: any) { setActiveRequest(req); }
  function closeRequest() { setActiveRequest(null); }

  // Complete modal
  const [activeCompleteRequest, setActiveCompleteRequest] = useState<any | null>(null);
  const completeFilesRef = useRef<HTMLInputElement | null>(null);
  const [completeDesc, setCompleteDesc] = useState<string>("");
  const [completing, setCompleting] = useState(false);
  const [completeFileNames, setCompleteFileNames] = useState<string[]>([]);
  const [completePreviewUrl, setCompletePreviewUrl] = useState<string | null>(null);
const [completePreviewFile, setCompletePreviewFile] = useState<File | null>(null);

useEffect(() => {
  return () => {
    if (completePreviewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(completePreviewUrl);
    }
  };
}, [completePreviewUrl]);

  function openComplete(req: any) { setActiveCompleteRequest(req); setCompleteDesc(""); }
  function closeComplete() {
  setActiveCompleteRequest(null);
  setCompleteDesc("");
  setCompleteFileNames([]);
  if (completeFilesRef.current) completeFilesRef.current.value = "";

  // also clear/revoke the preview
  if (completePreviewUrl?.startsWith("blob:")) URL.revokeObjectURL(completePreviewUrl);
  setCompletePreviewUrl(null);
  setCompletePreviewFile(null);
}

  async function submitComplete() {
    if (!activeCompleteRequest) return;
    setCompleting(true);
    try {
      const fd = new FormData();
      fd.append("description", completeDesc || "");
      const files = completeFilesRef.current?.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) fd.append("media", files[i]);
      }
      const res = await fetch(
        `${apiBase}/api/requests/${encodeURIComponent(activeCompleteRequest.id)}/complete`,
        { method: "POST", credentials: "include", headers: buildAuthHeaders(), body: fd }
      );
      const payload: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(extractMessage(payload, `Failed to complete request ${activeCompleteRequest.id}`));

      setPendingRequests((prev) => prev.filter((r) => String(r.id) !== String(activeCompleteRequest.id)));
      closeComplete();
      showToast("Request marked complete");
    } catch (err) {
      console.error("complete request error", err);
      showToast(err instanceof Error ? err.message : "Could not complete request");
    } finally {
      setCompleting(false);
    }
  }

  // Load profile + products
  useEffect(() => {
    const ac = new AbortController();
    async function load() {
      if (!creatorId) { setLoading(false); return; }
      try {
        setLoading(true);
        // profile
        const profRes = await fetch(`${apiBase}/api/creators/me`, {
          credentials: "include",
          signal: ac.signal,
          headers: buildAuthHeaders(),
        });
        const profJson: any = await profRes.json();
        const prof = profJson as Partial<CreatorProfile> & { gallery?: string[] };

        setCreator({
          creator_id: Number(prof?.creator_id || user?.id || creatorId),
          display_name: prof?.display_name || "",
          bio: (prof as any)?.bio || null,
          profile_image: (prof as any)?.profile_image || null,
          average_rating: Number((prof as any)?.average_rating || 0),
          products_count: Number((prof as any)?.products_count || 0),
        });
        setDisplayName(prof?.display_name || "");
        setBio(((prof as any)?.bio as string) || "");

        const cats = getStringArrayProp(profJson, "categories");
        if (cats && cats.length) setSelectedCategories(uniqStrings(cats));

        const galArr = Array.isArray((prof as any)?.gallery) ? ((prof as any)?.gallery as string[]) : [];
        setGallery((prev) => prev.map((g) => ({ position: g.position, url: galArr[g.position - 1] || null })));

        // products
        const prodRes = await fetch(`${apiBase}/api/products/user/${creatorId}`, {
          credentials: "include",
          signal: ac.signal,
        });
        const prodJson: any = await prodRes.json();
        const list = (isRecord(prodJson) && Array.isArray((prodJson as any).products)
          ? ((prodJson as any).products as unknown[])
          : []
        ).filter(isRecord);

        const typedProducts: Product[] = list.map((x) => {
          const id = getStringProp(x, "id") ?? "";
          const title = getStringProp(x, "title") ?? "";
          const description = getStringProp(x, "description") ?? null;
          const typeStr = getStringProp(x, "product_type") ?? "purchase";
          const product_type: Product["product_type"] =
            typeStr === "membership" ? "membership" : typeStr === "request" ? "request" : "purchase";
          const priceRaw = (x as any)["price"];
          const price =
            typeof priceRaw === "number"
              ? priceRaw
              : typeof priceRaw === "string"
              ? Number(priceRaw)
              : 0;
          return { id, title, description, product_type, price };
        });
        setProducts(typedProducts);

        // reflect fetched count
        setCreator((prev) => (prev ? { ...prev, products_count: typedProducts.length } : prev));
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          console.error("dashboard load error", e);
        }
      } finally {
        setLoading(false);
      }
    }
    load();
    return () => ac.abort();
  }, [creatorId, apiBase, user?.id]);

  // --- Average rating loader (robust) ---
  const loadAverageRating = useCallback(async () => {
    if (!creatorId) return;
    const idNum = Number(creatorId);
    const tryExtract = (obj: any): number | null => {
      if (!obj || typeof obj !== "object") return null;
      const candidates = [
        "average_rating", "avg_rating", "average", "avg", "rating",
        "ratings_avg", "mean", "score", "stars"
      ];
      for (const k of candidates) {
        const v = obj[k];
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
        if (!Number.isNaN(n) && Number.isFinite(n)) return n;
      }
      if (obj.summary) return tryExtract(obj.summary);
      return null;
    };

    // 1) canonical summary endpoint (if exists)
    const endpoints = [
      `${apiBase}/api/reviews/creator/${encodeURIComponent(idNum)}/summary`,
      `${apiBase}/api/reviews/creator/${encodeURIComponent(idNum)}?summary=1`,
    ];

    for (const url of endpoints) {
      try {
        const r = await fetch(url, { credentials: "include", headers: buildAuthHeaders() });
        if (!r.ok) continue;
        const data: any = await r.json().catch(() => ({}));
        const n = tryExtract(data);
        if (typeof n === "number") {
          setAverageRating(n);
          setCreator((prev) => (prev ? { ...prev, average_rating: n } : prev));
          return;
        }
      } catch {
        /* ignore and continue */
      }
    }

    // 2) fallback: fetch list & compute
    try {
      const r = await fetch(
        `${apiBase}/api/reviews/creator/${encodeURIComponent(idNum)}?limit=200&offset=0`,
        { credentials: "include", headers: buildAuthHeaders() }
      );
      if (r.ok) {
        const data: any = await r.json().catch(() => ({}));
        const list: any[] = Array.isArray(data?.reviews) ? data.reviews : Array.isArray(data) ? data : [];
        const ratings = list
          .map((it) => (typeof it?.rating === "number" ? it.rating : Number(it?.rating || 0)))
          .filter((n) => Number.isFinite(n) && n > 0);
        if (ratings.length > 0) {
          const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
          setAverageRating(avg);
          setCreator((prev) => (prev ? { ...prev, average_rating: avg } : prev));
          return;
        }
      }
    } catch {
      /* ignore */
    }
  }, [creatorId, apiBase]);

  useEffect(() => {
    if (creatorId) loadAverageRating();
  }, [creatorId, apiBase, products.length, loadAverageRating]);

  // Load categories
  useEffect(() => {
    const ac = new AbortController();
    async function loadAllCategories() {
      if (!creatorId) return;
      setCatsLoading(true);
      try {
        let items: CategoryItem[] = [];
        const endpoints = [
          `${apiBase}/api/categories`,
          `${apiBase}/api/category`,
          `${apiBase}/api/creators/${creatorId}/categories`,
        ];
        for (const url of endpoints) {
          try {
            const res = await fetch(url, { credentials: "include", signal: ac.signal });
            if (!res.ok) continue;
            const data: unknown = await res.json();
            items = toCategoryItemsFlexible(data);
            if (items.length > 0) break;
          } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") break;
          }
        }
        if (items.length === 0 && selectedCategories.length > 0) {
          items = selectedCategories.map((name) => ({ id: name, name }));
        }
        setAllCategories(items);
      } finally {
        setCatsLoading(false);
      }
    }
    loadAllCategories();
    return () => ac.abort();
  }, [creatorId, apiBase, selectedCategories]);

  // Stripe status
  useEffect(() => {
    const ac = new AbortController();
    async function loadStripeStatus() {
      if (!creatorId) return;
      setStripeLoading(true);
      try {
        const res = await fetch(`${apiBase}/api/stripe-connect/status`, {
          credentials: "include",
          signal: ac.signal,
          headers: buildAuthHeaders(),
        });
        if (res.ok) {
          const data: any = await res.json().catch(() => ({}));
          const connected =
            getBooleanProp(data, "connected") ?? getBooleanProp(data, "details_submitted") ?? null;
          setStripeConnected(connected);
        } else {
          const altRes = await fetch(`${apiBase}/api/me/creator-status`, {
            credentials: "include",
            signal: ac.signal,
            headers: buildAuthHeaders(),
          });
          if (altRes.ok) {
            const alt: any = await altRes.json();
            const sc = getBooleanProp(alt, "stripeConnected") ?? null;
            setStripeConnected(sc);
          } else {
            setStripeConnected(null);
          }
        }
      } catch {
        setStripeConnected(null);
      } finally {
        setStripeLoading(false);
      }
    }
    loadStripeStatus();
    return () => ac.abort();
  }, [creatorId, apiBase]);

  function toggleCategoryName(name: string) {
    setSelectedCategories((prev) => (prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]));
  }

  // Debounced auto-save categories
  useEffect(() => {
    if (!creatorId) return;
    if (!catsInitializedRef.current) { catsInitializedRef.current = true; return; }
    if (catsSaveTimerRef.current) clearTimeout(catsSaveTimerRef.current);
    catsSaveTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${apiBase}/api/creators/${creatorId}`, {
          method: "PUT",
          credentials: "include",
          headers: buildAuthHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ categories: selectedCategories }),
        });
        const payload: unknown = await res.json().catch(() => ({}));
        if (!res.ok) {
          console.warn("Auto-save categories failed:", extractMessage(payload, "Could not save categories"));
        } else if (isRecord(payload)) {
          const catsVal = (payload as any).categories;
          const serverCats = Array.isArray(catsVal) ? catsVal.filter((x: unknown) => typeof x === "string") as string[] : null;
          if (serverCats) setSelectedCategories(uniqStrings(serverCats));
        }
      } catch (e) {
        console.warn("Auto-save categories error:", e);
      }
    }, 800);
    return () => { if (catsSaveTimerRef.current) clearTimeout(catsSaveTimerRef.current); };
  }, [selectedCategories, creatorId, apiBase]);

  async function saveQuickProfile() {
    if (!creatorId) return;
    setSavingProfile(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`${apiBase}/api/creators/${creatorId}`, {
        method: "PUT",
        credentials: "include",
        headers: buildAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ display_name: displayName.trim(), bio: bio.trim(), categories: selectedCategories }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 401) throw new Error("Unauthorized — please sign in again.");
        if (res.status === 403) throw new Error("Forbidden — you don’t have permission to edit this profile.");
        throw new Error(text || "Failed to save profile");
      }
      const updated: any = await res.json().catch(() => ({}));
      const newDisplay = getStringProp(updated, "display_name") ?? displayName;
      const newBio = getStringProp(updated, "bio") ?? bio;
      const newCats = getStringArrayProp(updated, "categories");
      setCreator((prev) => ({
        ...(prev ?? ({} as CreatorProfile)),
        display_name: newDisplay,
        bio: newBio,
        profile_image: prev?.profile_image ?? null,
        average_rating: prev?.average_rating ?? 0,
        products_count: prev?.products_count ?? 0,
        creator_id: prev?.creator_id ?? Number(creatorId),
      }));
      if (newCats) setSelectedCategories(uniqStrings(newCats));
      setSaveMsg("Saved ✔");
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (e) {
      console.error("profile save error", e);
      setSaveMsg(e instanceof Error ? e.message : "Could not save profile");
    } finally {
      setSavingProfile(false);
    }
  }

  async function connectStripe() {
    try {
      setConnecting(true);
      const res = await fetch(`${apiBase}/api/stripe-connect/create-link`, {
        method: "POST",
        credentials: "include",
        headers: buildAuthHeaders(),
      });
      const data: any = await res.json();
      const url = getStringProp(data, "url");
      if (url) {
        window.location.href = url;
      } else {
        showToast(extractMessage(data, "Could not start Stripe onboarding"));
      }
    } catch {
      showToast("Stripe onboarding error");
    } finally {
      setConnecting(false);
    }
  }

  function requestDelete(id: string) {
    setDeleteErr(null);
    setConfirmDeleteId(id);
  }
  async function confirmDelete() {
    if (!confirmDeleteId) return;
    setDeleting(true);
    setDeleteErr(null);
    try {
      const res = await fetch(`${apiBase}/api/products/${encodeURIComponent(confirmDeleteId)}`, {
        method: "DELETE",
        credentials: "include",
        headers: buildAuthHeaders(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Failed to delete product");
      }
      const payload: any = await res.json().catch(() => ({}));
      const success = !!(payload?.success === true);
      if (!success) throw new Error(extractMessage(payload, "Delete failed"));

      setProducts((prev) => prev.filter((p) => p.id !== confirmDeleteId));
      setConfirmDeleteId(null);
    } catch (e) {
      console.error("delete product error", e);
      setDeleteErr(e instanceof Error ? e.message : "Could not delete product");
    } finally {
      setDeleting(false);
    }
  }

  async function loadReviewsForProduct(productId: string, nextPage = 1, limit = 20) {
    if (!creatorId) return;
    setReviewsMap((prev) => ({
      ...prev,
      [productId]: { ...(prev[productId] ?? { items: [], page: 0, hasMore: true }), loading: true },
    }));
    try {
      const offset = Math.max((nextPage - 1) * limit, 0);
      const res = await fetch(
        `${apiBase}/api/reviews/creator/${encodeURIComponent(Number(creatorId))}?limit=${limit}&offset=${offset}`,
        { credentials: "include", headers: buildAuthHeaders() }
      );
      if (!res.ok) throw new Error(`Failed to load reviews: ${res.status}`);
      const data: any = await res.json();

      const list: unknown[] = Array.isArray(data?.reviews) ? data.reviews : Array.isArray(data) ? data : [];
      const parsed: ReviewExtended[] = list
        .filter(isRecord)
        .map((r) => {
          const id = String((r as any).id ?? getStringProp(r, "id") ?? "");
          const ratingRaw = (r as any).rating ?? 0;
          const rating = typeof ratingRaw === "number" ? ratingRaw : Number(ratingRaw || 0);
          const comment = getStringProp(r, "comment") ?? "";
          const buyer = isRecord((r as any).buyer)
            ? { id: Number((r as any).buyer.id ?? (r as any).buyer_id ?? undefined), username: getStringProp((r as any).buyer, "username") ?? undefined, email: getStringProp((r as any).buyer, "email") ?? undefined }
            : { id: typeof (r as any).buyer_id === "number" ? (r as any).buyer_id : undefined, username: getStringProp(r, "buyer_username") ?? undefined, email: getStringProp(r, "buyer_email") ?? undefined };
          const created_at = getStringProp(r, "created_at") ?? getStringProp(r, "createdAt") ?? "";
          const product_id = (r as any).product_id != null ? String((r as any).product_id) : getStringProp(r, "productId") ?? null;
          const product = isRecord((r as any).product)
            ? {
                description: getStringProp((r as any).product, "description") ?? null,
                view_url: getStringProp((r as any).product, "view_url") ?? getStringProp((r as any).product, "viewUrl") ?? null,
                download_url: getStringProp((r as any).product, "download_url") ?? getStringProp((r as any).product, "downloadUrl") ?? null,
                product_type: getStringProp((r as any).product, "product_type") ?? getStringProp((r as any).product, "productType") ?? "purchase",
                title: getStringProp((r as any).product, "title") ?? "",
                filename: getStringProp((r as any).product, "filename") ?? "",
              }
            : ({ description: null, view_url: null, download_url: null, product_type: "purchase", title: "", filename: "" } as any);

          return {
            id,
            rating,
            comment,
            buyer_id: buyer?.id ?? (typeof (r as any).buyer_id === "number" ? (r as any).buyer_id : 0),
            created_at,
            product,
            buyer,
            product_id,
          } as ReviewExtended;
        })
        .filter((rv) => (rv.product_id == null ? false : String(rv.product_id) === String(productId)));

      setReviewsMap((prev) => {
        const prevEntry = prev[productId] ?? { items: [], page: 0, hasMore: true, loading: false };
        const combined = nextPage === 1 ? parsed : [...prevEntry.items, ...parsed];
        const hasMore = parsed.length >= limit && (data?.summary?.total ? combined.length < Number(data.summary.total) : parsed.length >= limit);
        return { ...prev, [productId]: { items: combined, page: nextPage, hasMore, loading: false } };
      });
    } catch (err) {
      console.error("loadReviewsForProduct error", err);
      setReviewsMap((prev) => ({
        ...prev,
        [productId]: { ...(prev[productId] ?? { items: [], page: 0, hasMore: false }), loading: false },
      }));
    }
  }

  function openReviews(productId: string) {
    setActiveReviewsProduct(productId);
    const entry = reviewsMap[productId];
    if (!entry || entry.items.length === 0) loadReviewsForProduct(productId, 1);
  }
  function closeReviews() { setActiveReviewsProduct(null); }
  function loadMoreReviews(productId: string) {
    const entry = reviewsMap[productId];
    const next = entry ? entry.page + 1 : 1;
    loadReviewsForProduct(productId, next);
  }

  const publicProfilePath = creatorId ? `/creators/${creatorId}` : "/";
  const onViewProfile = () => router.push(publicProfilePath);

  function showToast(text: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastText(text);
    setToastOpen(true);
    toastTimerRef.current = setTimeout(() => {
      setToastOpen(false);
      toastTimerRef.current = null;
    }, 4000);
  }
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

    const buildCreatorAttachmentUrl = useCallback((requestId: string | number) => {
      return `${apiBase}/api/requests/${encodeURIComponent(requestId)}/attachment`;
    }, [apiBase]);

        const handleDownloadAttachment = useCallback(async () => {
          try {
            if (!activeRequest?.id) return;
            // Let the browser handle the file download directly
            const url = `${apiBase}/api/requests/${encodeURIComponent(activeRequest.id)}/attachment/file`;
            window.location.href = url;
          } catch (e) {
            console.error("download attachment error", e);
            showToast("Download failed");
          }
        }, [activeRequest, apiBase]);

  const onCopyLink = async () => {
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const fullUrl = `${origin}${publicProfilePath}`;
      await navigator.clipboard.writeText(fullUrl);
      showToast("Profile link copied");
    } catch {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const fullUrl = `${origin}${publicProfilePath}`;
      window.prompt("Copy your profile link:", fullUrl);
      showToast("Profile link ready to copy");
    }
  };

  if (!creatorId) {
      return (
        <div className="min-h-screen bg-black">
          <main className="max-w-4xl mx-auto p-6">
            <h1 className="text-2xl font-bold">Creator Dashboard</h1>
            <p className="mt-2 text-sm text-neutral-700">Please sign in to view your dashboard.</p>
          </main>
        </div>
      );
    }

  /* ------------------------------- UI ------------------------------- */
        return (
          <div className="min-h-screen bg-black">
            {/* Toast — bright on black bg */}
            <div
              className={[
                "fixed left-1/2 bottom-8 z-[1000] -translate-x-1/2",
                "transition-all duration-300",
                toastOpen ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none",
              ].join(" ")}
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center gap-2 rounded-full px-4 py-2 text-black shadow-xl bg-gradient-to-r from-amber-300 to-yellow-400">
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="text-sm font-medium">{toastText}</span>
              </div>
            </div>

            <main className="mx-auto max-w-6xl px-4 py-8 space-y-8">
                  {/* Top bar */}
          <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-white p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 overflow-hidden rounded-full bg-neutral-100">
                {creator?.profile_image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={resolveImageUrl(creator.profile_image, apiBase) || creator.profile_image}
                    alt={creator?.display_name || "Creator"}
                    className="h-full w-full object-cover"
                  />
                ) : null}
              </div>
              <div>
                <h1 className="text-lg font-semibold">Dashboard</h1>
                <p className="text-xs text-neutral-600">
                  {loading ? "Loading…" : `Welcome, ${creator?.display_name || "creator"}`}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Average rating */}
              <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
                <StarRating value={Number(averageRating ?? creator?.average_rating ?? 0)} />
                <span className="text-sm font-medium">
                  {(Number(averageRating ?? creator?.average_rating ?? 0) || 0).toFixed(1)}
                </span>
              </div>
              {/* Product count from fetched list */}
              <div className="rounded-lg border px-3 py-2 text-sm">
                <span className="font-medium">{products.length}</span> products
              </div>
            </div>
          </header>

                  {/* Quick actions */}
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Copy profile link */}
            <div className="rounded-xl border bg-white p-4">
              <button
                onClick={onCopyLink}
                className="cursor-pointer w-full inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                title="Copy profile link"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8 7V5a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <rect x="3" y="7" width="11" height="14" rx="3" ry="3" fill="none" stroke="currentColor" strokeWidth="2" />
                </svg>
                Copy profile link
              </button>
              <p className="mt-2 text-xs text-neutral-600 text-center">
                Share your link on socials to increase engagement
              </p>
            </div>

            {/* View public profile (moved here from header) */}
            <div className="rounded-xl border bg-white p-4">
              <button
                onClick={onViewProfile}
                className="cursor-pointer w-full inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                title="View your public profile"
              >
                View public profile
              </button>
              <p className="mt-2 text-xs text-neutral-600 text-center">
                See how your page looks to others
              </p>
            </div>
          </section>

        {/* ROW 1: Quick Edit (2) • Pending (1) */}
        <section className="grid items-stretch grid-cols-1 md:grid-cols-3 gap-4">
          {/* Quick Edit */}
          <div className="md:col-span-2 h-full rounded-xl border bg-white p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Quick Edit</h2>
              {saveMsg && (
                <span className={`text-sm ${saveMsg.includes("Saved") ? "text-green-700" : "text-red-700"}`}>{saveMsg}</span>
              )}
            </div>

            <div className="grid gap-4 mt-4">
              {/* Display name */}
              <div>
                <label className="block text-xs font-medium text-neutral-700">Display name</label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Display name"
                  className="mt-1 w-full rounded-lg border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-neutral-900"
                />
              </div>

                              {/* Bio */}
              <div>
                <label className="block text-xs font-medium text-neutral-700">Bio</label>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="Tell buyers what you do"
                  rows={4}
                  className="mt-1 w-full rounded-lg border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-neutral-900"
                />
              </div>

                            <div className="flex items-center gap-3">
                <button
                  onClick={saveQuickProfile}
                  disabled={savingProfile}
                  className={`cursor-pointer rounded-lg px-4 py-2 text-sm font-medium ${
                    savingProfile
                      ? "bg-neutral-300 text-neutral-600"
                      : "bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                  }`}
                >
                  {savingProfile ? "Saving…" : "Save"}
                </button>
              </div>

              {/* Categories (kept as chips for clarity; pointer enabled) */}
              <div>
                <label className="block text-xs font-medium text-neutral-700">Categories</label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {catsLoading && allCategories.length === 0 ? (
                    <span className="text-sm text-neutral-500">Loading categories…</span>
                  ) : allCategories.length > 0 ? (
                    allCategories.map((cat) => {
                      const active = selectedCategories.includes(cat.name);
                      return (
                        <button
                          key={cat.id || cat.name}
                          type="button"
                          onClick={() => toggleCategoryName(cat.name)}
                          className={`cursor-pointer rounded-full border px-3 py-1 text-sm transition ${
                            active ? "bg-neutral-900 text-white border-neutral-900" : "hover:bg-neutral-100"
                          }`}
                          aria-pressed={active}
                          title={cat.name}
                        >
                          {cat.name}
                        </button>
                      );
                    })
                  ) : selectedCategories.length > 0 ? (
                    selectedCategories.map((name) => (
                      <button
                        key={`fallback-${name}`}
                        type="button"
                        onClick={() => toggleCategoryName(name)}
                        className="cursor-pointer rounded-full border px-3 py-1 text-sm bg-neutral-900 text-white border-neutral-900"
                        aria-pressed
                        title={name}
                      >
                        {name}
                      </button>
                    ))
                  ) : (
                    <span className="text-sm text-neutral-500">No categories configured yet.</span>
                  )}
                </div>

                {selectedCategories.some((n) => !allCategories.find((c) => c.name === n)) && (
                  <div className="mt-3">
                    <div className="text-xs text-neutral-500 mb-1">Your categories</div>
                    <div className="flex flex-wrap gap-2">
                      {selectedCategories
                        .filter((n) => !allCategories.find((c) => c.name === n))
                        .map((name) => (
                          <button
                            key={`own-${name}`}
                            type="button"
                            onClick={() => toggleCategoryName(name)}
                            className="cursor-pointer rounded-full border px-3 py-1 text-sm bg-neutral-900 text-white border-neutral-900"
                            aria-pressed
                            title={name}
                          >
                            {name}
                          </button>
                        ))}
                    </div>
                  </div>
                )}

                <p className="text-xs text-neutral-500 mt-2">Pick one or more categories that best describe your work. (Max three)</p>
              </div>

              {/* Profile Image (kept neutral UI, pointer added) */}
              <div>
                <label className="block text-xs font-medium text-neutral-700 mb-2">Profile Image</label>
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => profileImgInputRef.current?.click()}
                    className="cursor-pointer relative h-20 w-20 overflow-hidden rounded-full border bg-neutral-50 flex items-center justify-center text-xs text-neutral-500 hover:ring-2 hover:ring-black/20"
                    aria-label="Change profile image"
                  >
                    {creator?.profile_image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={resolveImageUrl(creator.profile_image, apiBase) || creator.profile_image}
                        alt="Profile"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span>Upload</span>
                    )}
                  </button>
                  <div className="text-xs text-neutral-600 max-w-xs">
                    Click the image to upload / replace. JPG, PNG, WEBP, GIF up to 15MB.
                  </div>
                  <input
                    ref={profileImgInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        const fd = new FormData();
                        fd.append("profile_image", file);
                        const res = await fetch(`${apiBase}/api/creators/me/profile-image`, {
                          method: "PATCH",
                          credentials: "include",
                          headers: buildAuthHeaders(),
                          body: fd,
                        });
                        if (!res.ok) throw new Error(await res.text());
                        const data: any = await res.json();
                        const url = data?.profile_image as string | undefined;
                        if (url) {
                          setCreator((prev) => (prev ? { ...prev, profile_image: url } : prev));
                          showToast("Profile image updated");
                        }
                      } catch (err) {
                        console.error(err);
                        showToast("Profile image upload failed");
                      } finally {
                        e.target.value = ""; // reset
                      }
                    }}
                  />
                </div>
              </div>
                            {/* Gallery (4 photos) */}
              <div>
                <label className="block text-xs font-medium text-neutral-700 mb-2">
                  Gallery Photos (4)
                </label>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {gallery.map((g, idx) => (
                    <div key={g.position} className="flex flex-col items-center gap-1">
                      <button
                        type="button"
                        onClick={() => galleryInputRefs[idx].current?.click()}
                        className="cursor-pointer relative h-28 w-full overflow-hidden rounded-lg border bg-neutral-50 flex items-center justify-center text-xs text-neutral-600 hover:ring-2 hover:ring-black/20"
                        aria-label={`Replace gallery photo ${g.position}`}
                      >
                        {g.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={resolveImageUrl(g.url, apiBase) || g.url}
                            alt={`Gallery ${g.position}`}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span>Photo {g.position}</span>
                        )}
                        <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">
                          Edit
                        </span>
                      </button>

                      <input
                        ref={galleryInputRefs[idx]}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          try {
                            const fd = new FormData();
                            fd.append("photo", file);
                            const res = await fetch(
                              `${apiBase}/api/creators/me/gallery/${g.position}`,
                              {
                                method: "PATCH",
                                credentials: "include",
                                headers: buildAuthHeaders(),
                                body: fd,
                              }
                            );
                            if (!res.ok) throw new Error(await res.text());
                            const data: any = await res.json();
                            const newUrl = data?.url as string | undefined;
                            const newGallery: string[] | undefined = data?.gallery;

                            setGallery((prev) =>
                              prev.map((ph) =>
                                ph.position === g.position
                                  ? { ...ph, url: newUrl || ph.url }
                                  : newGallery && newGallery[ph.position - 1]
                                  ? { ...ph, url: newGallery[ph.position - 1] }
                                  : ph
                              )
                            );
                            showToast(`Gallery photo ${g.position} updated`);
                          } catch (err) {
                            console.error(err);
                            showToast("Gallery upload failed");
                          } finally {
                            e.target.value = "";
                          }
                        }}
                      />
                    </div>
                  ))}
                </div>

                <p className="text-xs text-neutral-500 mt-2">
                  These appear on the back of your creator card.
                </p>
              </div>


            </div>
          </div>

          {/* Pending Requests — tall panel with internal scroll */}
          <div className="h-[65vh] rounded-xl border bg-white p-5 flex flex-col">
            <div className="flex justify-between items-center mb-2">
              <h2 className="font-semibold">Pending Requests</h2>
              <button
                onClick={() => loadPending()}
                className="cursor-pointer text-xs rounded-md px-2 py-1 font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
              >
                Refresh
              </button>
            </div>
            {pendingLoading ? (
              <div className="text-sm text-neutral-600">Loading…</div>
            ) : pendingRequests.length === 0 ? (
              <div className="text-sm text-neutral-600">
                No pending requests yet.
                <div className="text-xs text-neutral-500 mt-1">
                  Requests will appear here when buyers submit them.
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {pendingRequests.map((req) => (
                  <div key={req.id} className="rounded-lg border p-3 bg-neutral-50 hover:bg-neutral-100 transition">
                    <div className="flex justify-between items-start">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">{req.product_title || `Request #${req.id}`}</div>
                        {req.amount !== undefined && req.amount !== null && (
                          <div className="text-sm font-medium text-neutral-900 mt-1">
                            ${(req.amount / 100).toFixed(2)}
                          </div>
                        )}
                        <div className="text-xs text-neutral-500 mt-1">
                          {new Date(req.created_at).toLocaleDateString()} · {new Date(req.created_at).toLocaleTimeString()}
                        </div>
                      </div>
                      <div className="ml-2 shrink-0 flex gap-2">
                        <button
                          onClick={() => openRequest(req)}
                          className="cursor-pointer text-xs px-3 py-1 rounded-md font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                        >
                          View
                        </button>
                        <button
                          onClick={() => openComplete(req)}
                          className="cursor-pointer text-xs px-3 py-1 rounded-md font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                        >
                          Complete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ROW 2: Stripe • Manage in Feed (distinct) • Add Product */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Stripe */}
          <div className="rounded-xl border bg-white p-5">
            <h2 className="font-semibold mb-2">Stripe Connect</h2>
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${stripeConnected ? "bg-green-500" : stripeConnected === false ? "bg-red-500" : "bg-neutral-300"}`}
                aria-hidden="true"
              />
              <span className="text-sm text-neutral-700">
                {stripeLoading
                  ? "Checking status…"
                  : stripeConnected
                  ? "Connected"
                  : stripeConnected === false
                  ? "Not connected"
                  : "Status unavailable"}
              </span>
            </div>

            <button
              onClick={connectStripe}
              disabled={connecting}
              className={`cursor-pointer mt-3 w-full rounded-lg px-4 py-2 text-sm font-medium ${
                connecting
                  ? "bg-neutral-300 text-neutral-700"
                  : "bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
              }`}
            >
              {connecting ? "Redirecting…" : stripeConnected ? "Manage in Stripe" : "Connect Stripe"}
            </button>
          </div>

          {/* Manage in Feed — EXEMPT from gradient */}
          <button
            type="button"
            onClick={() => router.push("/feed")}
            className={`cursor-pointer rounded-xl p-5 flex items-center justify-center text-center shadow-sm
              ${hasMembership ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-indigo-50 text-indigo-900 border border-indigo-200"}
            `}
            title="Manage feed posts"
          >
            <div className="flex flex-col items-center gap-2">
              <div className={`flex h-12 w-12 items-center justify-center rounded-full ${hasMembership ? "bg-white/20" : "bg-indigo-100"}`}>
                <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <span className="text-sm font-semibold">
                {hasMembership ? "Manage Membship(s) Feed" : "No memberships yet"}
              </span>
              {!hasMembership && (
                <span className="text-xs opacity-80">Create a membership to start posting</span>
              )}
            </div>
          </button>

          {/* Add Product — EXEMPT from gradient */}
          <button
            type="button"
            onClick={() => router.push("/dashboard/products/new")}
            className="cursor-pointer rounded-xl border bg-white p-5 flex items-center justify-center hover:bg-neutral-50"
            title="Add Product"
          >
            <div className="flex flex-col items-center gap-2">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-dashed">
                <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <span className="text-sm font-medium">Add Product</span>
            </div>
          </button>
        </section>

        {/* Products grid — compact cards */}
        <section>
          <h2 className="font-semibold mb-2 text-white">Your Products</h2>
          {loading ? (
            <div className="text-sm text-neutral-300">Loading…</div>
          ) : products.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {products.map((p) => (
                <div key={p.id} className="rounded-lg border bg-white p-3 hover:shadow-sm transition">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] uppercase tracking-wide text-neutral-600">{p.product_type}</span>
                    <span className="text-xs font-semibold">${((p.price || 0) / 100).toFixed(2)}</span>
                  </div>
                  <div className="mt-1 font-semibold truncate">{p.title}</div>
                  {p.description && (
                    <p className="text-xs text-neutral-600 mt-1 line-clamp-2">{p.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      className="cursor-pointer rounded-md px-2.5 py-1 text-xs text-white font-medium bg-blue-700 hover:brightness-95"
                      onClick={() => router.push(`/products/${p.id}`)}
                    >
                      Edit
                    </button>
                    <button
                      className="cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium bg-red-300 hover:brightness-95"
                      onClick={() => requestDelete(p.id)}
                    >
                      Delete
                    </button>
                    <button
                      className="cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                      onClick={() => openReviews(p.id)}
                    >
                      Reviews
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-neutral-300">No products yet.</div>
          )}
        </section>

        {/* Delete confirm modal */}
        {confirmDeleteId && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-6">
              <h3 className="text-lg font-semibold">Delete product?</h3>
              <p className="text-sm text-neutral-700">
                This action cannot be undone. Are you sure you want to delete this product?
              </p>
              {deleteErr && (
                <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">
                  {deleteErr}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                  disabled={deleting}
                >
                  No
                </button>
                <button
                  onClick={confirmDelete}
                  className={`cursor-pointer rounded-lg px-4 py-2 text-sm font-medium text-black ${
                    deleting ? "bg-neutral-300" : "bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                  }`}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Yes, delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Request details modal */}
        {activeRequest && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div
                  className="w-full max-w-lg rounded-xl bg-white p-6 max-h-[85vh] overflow-y-auto"
                  style={{ WebkitOverflowScrolling: "touch" }} // smooth iOS scroll
                >
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold">
                  {activeRequest.product_title || `Request #${activeRequest.id}`}
                </h3>
              </div>

              <div className="space-y-2">
                {activeRequest.user && (
                  <div className="text-sm text-neutral-700">Detail: {activeRequest.user}</div>
                )}
                {activeRequest.amount !== undefined && activeRequest.amount !== null && (
                  <div className="text-sm font-semibold">Amount: ${((activeRequest.amount || 0) / 100).toFixed(2)}</div>
                )}
                <div className="text-xs text-neutral-500">
                  {new Date(activeRequest.created_at).toLocaleDateString()} · {new Date(activeRequest.created_at).toLocaleTimeString()}
                </div>
                {activeRequest.attachment_path ? (
                  <div className="pt-2 space-y-3">
                    {/* Streamed inline from protected endpoint (works for S3/local) */}
                    <AttachmentViewer src={buildCreatorAttachmentUrl(activeRequest.id)} />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleDownloadAttachment}
                        className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium inline-flex items-center gap-2 bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                        </svg>
                        Download
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2">
                <button onClick={closeRequest} className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95">Close</button>
                <button
                  onClick={() => { closeRequest(); openComplete(activeRequest); }}
                  className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                >
                  Complete
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Complete request modal */}
        {activeCompleteRequest && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div
                  className="w-full max-w-lg rounded-xl bg-white p-6 max-h-[85vh] overflow-y-auto"
                  style={{ WebkitOverflowScrolling: "touch" }} // smooth iOS scroll
                >
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold">Complete Request</h3>
                <button onClick={closeComplete} className="cursor-pointer text-sm rounded-md px-2 py-1 font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95">Close</button>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-neutral-700">Description (required)</label>
                  <textarea
                    value={completeDesc}
                    onChange={(e) => setCompleteDesc(e.target.value)}
                    rows={4}
                    placeholder="Describe what you delivered or include buyer notes"
                    className="mt-1 w-full rounded-lg border px-3 py-2 focus:outline-none focus:ring-2 focus:ring-neutral-900"
                  />
                </div>

                <div>
  <label className="block text-xs font-medium text-neutral-700 mb-1">
    Attachments (optional)
  </label>

  {/* Hidden native input */}
<input
  id="complete-files"
  ref={completeFilesRef}
  type="file"
  accept="image/*,video/*,audio/*,.mp3,.wav,.m4a,.aac,.ogg,.webm"
  multiple
  className="hidden"
  onChange={(e) => {
    const files = Array.from(e.target.files ?? []);
    setCompleteFileNames(files.map((f) => f.name));

    if (completePreviewUrl?.startsWith("blob:")) URL.revokeObjectURL(completePreviewUrl);
    const first = files[0] || null;
    setCompletePreviewFile(first);
    setCompletePreviewUrl(first ? URL.createObjectURL(first) : null);
  }}
/>
{completePreviewUrl && (
  <div className="mt-3">
    <LocalAttachmentPreview file={completePreviewFile} url={completePreviewUrl} />
  </div>
)}

  {/* Trigger + filename display */}
  <div className="flex items-center gap-3">
    <button
      type="button"
      onClick={() => completeFilesRef.current?.click()}
      className="cursor-pointer inline-flex items-center rounded-lg bg-black text-white px-3 py-2 text-sm hover:bg-black/90"
    >
      Choose files
    </button>

    {/* Names (truncate long lists nicely) */}
    <div className="text-xs text-neutral-700 max-w-full overflow-hidden">
      {completeFileNames.length === 0 ? (
        <span className="text-neutral-500">No files selected</span>
      ) : (
        <span className="block truncate" title={completeFileNames.join(", ")}>
          {completeFileNames.join(", ")}
        </span>
      )}
    </div>
  </div>

  <p className="text-xs text-neutral-500 mt-1">
    You can attach images or a short video.
  </p>
</div>

              <div className="flex items-center justify-end gap-2">
                <button onClick={closeComplete} className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95" disabled={completing}>Cancel</button>
                <button
                  onClick={submitComplete}
                  className={`cursor-pointer rounded-lg px-4 py-2 text-sm font-medium text-black ${
                    completing ? "bg-neutral-300" : "bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                  }`}
                  disabled={completing || !completeDesc.trim()}
                >
                  {completing ? "Submitting…" : "Submit & Mark Complete"}
                </button>
              </div>
            </div>
          </div>
          </div>
        )}

        {/* Reviews modal */}
        {activeReviewsProduct && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-2xl space-y-4 rounded-xl bg-white p-6">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold">Reviews for product</h3>
                <button onClick={closeReviews} className="cursor-pointer text-sm rounded-md px-2 py-1 font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95">Close</button>
              </div>
              <div className="max-h-96 overflow-y-auto space-y-3">
                {(reviewsMap[activeReviewsProduct]?.items ?? []).length === 0 &&
                !reviewsMap[activeReviewsProduct]?.loading ? (
                  <div className="text-sm text-neutral-600">No reviews yet.</div>
                ) : (
                  (reviewsMap[activeReviewsProduct]?.items ?? []).map((r) => (
                    <div key={r.id} className="rounded-lg border p-3 bg-neutral-50">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{r.buyer?.username ?? r.buyer?.email ?? `Buyer ${r.buyer_id}`}</div>
                        <div className="text-sm text-neutral-500">{new Date(r.created_at).toLocaleDateString()}</div>
                      </div>
                      <div className="text-sm text-neutral-700 mt-1">{r.comment}</div>
                      <div className="text-xs text-neutral-500 mt-2">
                        Rating:
                        <span className="ml-1 inline-flex" aria-label={`Rating ${r.rating} out of 5`} title={`${r.rating} out of 5`}>
                          {Array.from({ length: 5 }).map((_, i) => {
                            const numeric = typeof r.rating === "number" ? r.rating : Number(r.rating || 0);
                            const filled = i < Math.round(Math.max(0, Math.min(5, numeric)));
                            return (
                              <span key={i} className={filled ? "text-yellow-500" : "text-neutral-300"}>
                                {filled ? "★" : "☆"}
                              </span>
                            );
                          })}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="flex items-center justify-between">
                <div className="text-xs text-neutral-500">
                  {(reviewsMap[activeReviewsProduct]?.items ?? []).length} reviews
                </div>
                <div>
                  {reviewsMap[activeReviewsProduct]?.loading ? (
                    <button className="cursor-pointer rounded-lg px-3 py-1 bg-neutral-200 text-sm">Loading…</button>
                  ) : reviewsMap[activeReviewsProduct]?.hasMore ? (
                    <button
                      onClick={() => loadMoreReviews(activeReviewsProduct)}
                      className="cursor-pointer rounded-lg px-3 py-1 text-sm font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
                    >
                      Load more
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        )}
         </main>
 </div>
  );
}
