// src/app/dashboard/page.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { loadAuth } from "@/lib/auth";

// ----- Types -----
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

// Enhanced review type: include buyer info and product id, defensive optional fields
type ReviewExtended = Review & {
  buyer?: { id?: number; username?: string | null; email?: string | null } | null;
  product_id?: string | null;
};

// --------- Safe helpers ----------
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

// Attach Authorization header (Bearer) when we have a saved token
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

// Resolve relative /uploads paths to full URLs
function resolveImageUrl(src: string | null | undefined, apiBase: string): string | null {
  if (!src) return null;
  let s = src.trim();
  if (s.startsWith("//")) s = s.slice(1);
  if (/^https?:\/\//i.test(s)) return s;
  if (!s.startsWith("/")) s = `/${s}`;
  return `${apiBase}${s}`;
}

export default function DashboardPage() {
  const router = useRouter();
  const { user } = useAuth?.() ?? { user: null };

  const token = loadAuth()?.token ?? null;

  useEffect(() => {
    (async () => {
      try {
        const review = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000"}/api/me`, {
          credentials: "include",
          headers: buildAuthHeaders(),
        });


      } catch (error) {
        console.error("Error checking auth:", error);
      } finally {
        // You can add any cleanup or final actions here if needed
      }
    })();
  }, []);

  // --- Place apiBase, creatorId, and pending requests state/effect after user is defined ---
  // (MUST be after user is defined)
  const apiBase = useMemo(
    () => (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, ""),
    []
  );
  const creatorId = user?.id ? String(user.id) : null;
  // Pending Requests state
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);

  // Expose a reusable loader so the Refresh button can trigger it
  const loadPending = useCallback(async () => {
    if (!creatorId) return;
    setPendingLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/requests/inbox?status=pending`, {
        credentials: "include",
        headers: buildAuthHeaders(),
      });

      if (!res.ok) {
        console.error("Failed to load pending requests:", res.status, res.statusText);
        throw new Error("Failed to load pending requests");
      }

      const data: unknown = await res.json();
      console.log("Pending requests response:", data); // Debug log

      let list: any[] = [];
      if (Array.isArray((data as any)?.requests)) {
        list = (data as any).requests;
      } else if (Array.isArray(data)) {
        list = data as any[];
      }

      console.log("Parsed pending requests:", list); // Debug log
      setPendingRequests(list);
    } catch (e) {
      console.error("Failed to load pending requests:", e);
      setPendingRequests([]);
    } finally {
      setPendingLoading(false);
    }
  }, [creatorId, apiBase]);

  // Initial load
  useEffect(() => {
    if (!creatorId) return;
    loadPending();
  }, [creatorId, loadPending]);

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
  // Derived: whether creator has any membership products
  const hasMembership = useMemo(() => products.some(p => p.product_type === 'membership'), [products]);

  // Reviews state: map productId -> { items, page, hasMore, loading }
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

  // Dynamic categories from DB
  const [allCategories, setAllCategories] = useState<CategoryItem[]>([]);
  const [catsLoading, setCatsLoading] = useState(false);

  // Stripe
  const [connecting, setConnecting] = useState(false);
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeConnected, setStripeConnected] = useState<boolean | null>(null);

  // Delete confirm
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // NEW: Toast state
  const [toastOpen, setToastOpen] = useState(false);
  const [toastText, setToastText] = useState<string>("");
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Active request modal
  const [activeRequest, setActiveRequest] = useState<any | null>(null);
  function openRequest(req: any) {
    setActiveRequest(req);
  }
  function closeRequest() {
    setActiveRequest(null);
  }

  // Complete-request modal state
  const [activeCompleteRequest, setActiveCompleteRequest] = useState<any | null>(null);
  const completeFilesRef = useRef<HTMLInputElement | null>(null);
  const [completeDesc, setCompleteDesc] = useState<string>("");
  const [completing, setCompleting] = useState(false);
  function openComplete(req: any) {
    setActiveCompleteRequest(req);
    setCompleteDesc("");
  }
  function closeComplete() {
    setActiveCompleteRequest(null);
    setCompleteDesc("");
    if (completeFilesRef.current) completeFilesRef.current.value = "";
  }

  async function submitComplete() {
    if (!activeCompleteRequest) return;
    setCompleting(true);
    try {
      const fd = new FormData();
      fd.append("description", completeDesc || "");
      const files = completeFilesRef.current?.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          fd.append("media", files[i]);
        }
      }
      
      console.log(fd.getAll("media")); // Debug log
      
      const res = await fetch(`${apiBase}/api/requests/${encodeURIComponent(activeCompleteRequest.id)}/complete`, {
        method: "POST",
        credentials: "include",
        headers: buildAuthHeaders(),
        body: fd,
      });

      console.log("Complete request response status:", res.status); // Debug log
      
      const payload: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = extractMessage(payload, `Failed to complete request ${activeCompleteRequest.id}`);
        throw new Error(err);
      }

      // Success: remove from pendingRequests if present and close modal
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



  // Load creator profile & products
  useEffect(() => {
    const ac = new AbortController();

    async function load() {
      if (!creatorId) {
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        // Own profile (includes ungated + gallery)
        const profRes = await fetch(`${apiBase}/api/creators/me`, {
          credentials: "include",
          signal: ac.signal,
          headers: buildAuthHeaders(),
        });
        const profJson: unknown = await profRes.json();
        // If not eligible yet, fields may differ but we map defensively
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
        if (cats) setSelectedCategories(uniqStrings(cats));
        const galArr = Array.isArray((prof as any)?.gallery)
          ? ((prof as any)?.gallery as string[])
          : [];
        setGallery((prev) =>
          prev.map((g) => ({ position: g.position, url: galArr[g.position - 1] || null }))
        );

        // Products
        const prodRes = await fetch(`${apiBase}/api/products/user/${creatorId}`, {
          credentials: "include",
          signal: ac.signal,
        });
        const prodJson: unknown = await prodRes.json();
        const list =
          (isRecord(prodJson) && Array.isArray((prodJson as Record<string, unknown>).products)
            ? (((prodJson as Record<string, unknown>).products as unknown[]) || [])
            : []
          ).filter(isRecord);
        const typedProducts: Product[] = list.map((x) => {
          const id = getStringProp(x, "id") ?? "";
          const title = getStringProp(x, "title") ?? "";
          const description = getStringProp(x, "description") ?? null;
          const typeStr = getStringProp(x, "product_type") ?? "purchase";
          const product_type: Product["product_type"] =
            typeStr === "membership" ? "membership" : typeStr === "request" ? "request" : "purchase";
          const priceRaw = isRecord(x) ? (x as Record<string, unknown>)["price"] : undefined;
          const price =
            typeof priceRaw === "number"
              ? priceRaw
              : typeof priceRaw === "string"
                ? Number(priceRaw)
                : 0;
          return { id, title, description, product_type, price };
        });
        setProducts(typedProducts);
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
  }, [creatorId, apiBase]);

  // Load categories list from DB (tolerant parsing)
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

  // Load Stripe connect status (requires auth)
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
          const data: unknown = await res.json().catch(() => ({}));
          const connected =
            getBooleanProp(data, "connected") ??
            getBooleanProp(data, "details_submitted") ??
            null;
          setStripeConnected(connected);
        } else {
          // fallback
          try {
            const altRes = await fetch(`${apiBase}/api/me/creator-status`, {
              credentials: "include",
              signal: ac.signal,
              headers: buildAuthHeaders(),
            });
            if (altRes.ok) {
              const alt: unknown = await altRes.json();
              const sc = getBooleanProp(alt, "stripeConnected") ?? null;
              setStripeConnected(sc);
            } else {
              setStripeConnected(null);
            }
          } catch {
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
    setSelectedCategories((prev) =>
      prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]
    );
  }

  async function saveQuickProfile() {
    if (!creatorId) return;
    setSavingProfile(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`${apiBase}/api/creators/${creatorId}`, {
        method: "PUT",
        credentials: "include",
        headers: buildAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          display_name: displayName.trim(),
          bio: bio.trim(),
          categories: selectedCategories,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 401) throw new Error("Unauthorized — please sign in again.");
        if (res.status === 403)
          throw new Error("Forbidden — you don’t have permission to edit this profile.");
        throw new Error(text || "Failed to save profile");
      }
      const updated: unknown = await res.json().catch(() => ({}));
      const newDisplay = getStringProp(updated, "display_name") ?? displayName;
      const newBio = getStringProp(updated, "bio") ?? bio;

      setCreator((prev) => ({
        ...(prev ?? ({} as CreatorProfile)),
        display_name: newDisplay,
        bio: newBio,
        profile_image: prev?.profile_image ?? null,
        average_rating: prev?.average_rating ?? 0,
        products_count: prev?.products_count ?? 0,
        creator_id: prev?.creator_id ?? Number(creatorId),
      }));
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
      const data: unknown = await res.json();
      const url = getStringProp(data, "url");
      if (url) {
        window.location.href = url;
      } else {
        // use toast instead of alert for consistency
        showToast(extractMessage(data, "Could not start Stripe onboarding"));
      }
    } catch {
      showToast("Stripe onboarding error");
    } finally {
      setConnecting(false);
    }
  }

  // Delete product (protected)
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
      const payload: unknown = await res.json().catch(() => ({}));
      const success =
        (isRecord(payload) &&
          typeof (payload as Record<string, unknown>).success === "boolean" &&
          (payload as Record<string, unknown>).success === true) || false;
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

  // --- Reviews loader ---
  async function loadReviewsForProduct(productId: string, nextPage = 1, limit = 20) {
    // Backend exposes creator-level listing: GET /api/reviews/creator/:creatorId?limit=20&offset=0
    // We fetch reviews for the current creator (creatorId) and then filter client-side for the productId.
    if (!creatorId) return;
    setReviewsMap((prev) => ({
      ...prev,
      [productId]: { ...(prev[productId] ?? { items: [], page: 0, hasMore: true }), loading: true },
    }));
    try {
      const offset = Math.max((nextPage - 1) * limit, 0);
      const res = await fetch(`${apiBase}/api/reviews/creator/${encodeURIComponent(Number(creatorId))}?limit=${limit}&offset=${offset}`, {
        credentials: "include",
        headers: buildAuthHeaders(),
      });
      if (!res.ok) throw new Error(`Failed to load reviews: ${res.status}`);
      const data: any = await res.json();

      // data.reviews is expected (array), plus optional summary
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
        // filter to only reviews that reference this product (if product_id is set)
        .filter((rv) => rv.product_id === null || rv.product_id === undefined ? false : String(rv.product_id) === String(productId));

      setReviewsMap((prev) => {
        const prevEntry = prev[productId] ?? { items: [], page: 0, hasMore: true, loading: false };
        const combined = nextPage === 1 ? parsed : [...prevEntry.items, ...parsed];
        const hasMore = parsed.length >= limit && (data?.summary?.total ? combined.length < Number(data.summary.total) : parsed.length >= limit);
        return { ...prev, [productId]: { items: combined, page: nextPage, hasMore, loading: false } };
      });
    } catch (err) {
      console.error("loadReviewsForProduct error", err);
      setReviewsMap((prev) => ({ ...prev, [productId]: { ...(prev[productId] ?? { items: [], page: 0, hasMore: false }), loading: false } }));
    }
  }

  function openReviews(productId: string) {
    setActiveReviewsProduct(productId);
    const entry = reviewsMap[productId];
    if (!entry || entry.items.length === 0) {
      loadReviewsForProduct(productId, 1);
    }
  }

  function closeReviews() {
    setActiveReviewsProduct(null);
  }

  function loadMoreReviews(productId: string) {
    const entry = reviewsMap[productId];
    const next = entry ? entry.page + 1 : 1;
    loadReviewsForProduct(productId, next);
  }

  // ----- NEW: View profile + Copy link actions -----
  const publicProfilePath = creatorId ? `/creators/${creatorId}` : "/";
  const onViewProfile = () => router.push(publicProfilePath);

  // Toast helpers
  function showToast(text: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastText(text);
    setToastOpen(true);
    toastTimerRef.current = setTimeout(() => {
      setToastOpen(false);
      toastTimerRef.current = null;
    }, 5000);
  }
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // Build full URL for an attachment that may be stored as a basename or web path
  const buildAttachmentUrl = useCallback((p: string) => {
    const clean = String(p || "");
    const webPath = clean.startsWith("/uploads/")
      ? clean
      : `/uploads/${clean.replace(/^\/+/, "")}`;
    return `${apiBase}${webPath}`;
  }, [apiBase]);

  // Auto-download the buyer's attachment in the active request modal
  const handleDownloadAttachment = useCallback(async () => {
    try {
      const p = (activeRequest as any)?.attachment_path as string | undefined;
      if (!p) return;
      const url = buildAttachmentUrl(p);
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const filename = String(p).split(/[\\\/]/).pop() || "attachment";
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      console.error("download attachment error", e);
      showToast("Download failed");
    }
  }, [activeRequest, buildAttachmentUrl]);

  const onCopyLink = async () => {
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const fullUrl = `${origin}${publicProfilePath}`;
      await navigator.clipboard.writeText(fullUrl);
      showToast("Profile link copied to clipboard");
    } catch {
      // Fallback prompt (still show toast so it feels consistent)
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const fullUrl = `${origin}${publicProfilePath}`;
      window.prompt("Copy your profile link:", fullUrl);
      showToast("Profile link ready to copy");
    }
  };

  if (!creatorId) {
    return (
      <main className="max-w-4xl mx-auto p-6">
        <h1 className="text-2xl font-bold">Creator Dashboard</h1>
        <p className="mt-2 text-sm text-neutral-700">Please sign in to view your dashboard.</p>
      </main>
    );
  }

  return (
    <>
      {/* Toast (Instagram-style): bottom center, grey bg, check icon, fade/slide */}
      <div
        className={[
          "fixed left-1/2 bottom-8 z-[1000] -translate-x-1/2",
          "transition-all duration-300",
          toastOpen ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none",
        ].join(" ")}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-2 rounded-full bg-neutral-800 px-4 py-2 text-white shadow-lg">
          {/* Check icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M20 6L9 17l-5-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="text-sm">{toastText}</span>
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-4 py-8 space-y-8">
        {/* Header: avatar + name + stats */}
        <header className="flex items-center gap-4">
          <div className="relative h-20 w-20 overflow-hidden rounded-full bg-neutral-100">
            {creator?.profile_image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={resolveImageUrl(creator.profile_image, apiBase) || creator.profile_image}
                alt={creator.display_name || "Creator"}
                className="h-full w-full object-cover"
              />
            ) : null}
          </div>
          <div>
            <h1 className="text-2xl font-bold">
              {loading ? "Loading..." : creator?.display_name || "Your Profile"}
            </h1>
            {creator?.bio && <p className="text-neutral-700">{creator.bio}</p>}
            {creator && (
              <div className="text-sm text-neutral-600 mt-1">
                {(Number(creator.average_rating) || 0).toFixed(1)} ★ · {creator.products_count} products
              </div>
            )}
          </div>
        </header>

        {/* View profile & Copy link actions */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* View Profile card */}
          <div className="rounded-2xl border p-4">
            <button
              onClick={onViewProfile}
              className="w-full rounded-xl bg-black py-2 text-white hover:bg-black/90"
              aria-label="View your public profile"
            >
              View your profile
            </button>
            <p className="mt-2 text-xs text-neutral-600 text-center">
              See how your profile looks to others
            </p>
          </div>

          {/* Copy Link card */}
          <div className="rounded-2xl border p-4">
            <button
              onClick={onCopyLink}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl border py-2 hover:bg-neutral-50"
              aria-label="Copy your profile link"
              title="Copy profile link"
            >
              {/* Copy icon */}
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M8 7V5a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <rect
                  x="3"
                  y="7"
                  width="11"
                  height="14"
                  rx="3"
                  ry="3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
              Copy profile link
            </button>
            <p className="mt-2 text-xs text-neutral-600 text-center">
              Copy your profile link to share for more engagement by adding to social media profiles
            </p>
          </div>
        </section>

        {/* ROW 1: Quick Edit (span 2) • Pending (span 1) */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Quick Edit: wider */}
          <div className="md:col-span-2 rounded-2xl border p-4">
            <div className="font-semibold mb-2">Quick Edit: Profile</div>
            <div className="grid gap-3">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-neutral-700">Display name</label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Display name"
                  className="w-full rounded-xl border px-3 py-2"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-neutral-700">Categories</label>

                {/* Category chips from DB */}
                <div className="flex flex-wrap gap-2">
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
                          className={`rounded-full border px-3 py-1 text-sm ${active ? "bg-black text-white border-black" : "hover:bg-neutral-100"
                            }`}
                          aria-pressed={active}
                          title={cat.name}
                        >
                          {cat.name}
                        </button>
                      );
                    })
                  ) : (
                    <span className="text-sm text-neutral-500">No categories configured yet.</span>
                  )}
                </div>

                {/* If creator has a category that's not in the master list, show it too */}
                {selectedCategories.some((n) => !allCategories.find((c) => c.name === n)) && (
                  <div className="mt-2">
                    <div className="text-xs text-neutral-500 mb-1">Your categories</div>
                    <div className="flex flex-wrap gap-2">
                      {selectedCategories
                        .filter((n) => !allCategories.find((c) => c.name === n))
                        .map((name) => (
                          <button
                            key={`own-${name}`}
                            type="button"
                            onClick={() => toggleCategoryName(name)}
                            className="rounded-full border px-3 py-1 text-sm bg-black text-white border-black"
                            aria-pressed
                            title={name}
                          >
                            {name}
                          </button>
                        ))}
                    </div>
                  </div>
                )}

                <p className="text-xs text-neutral-500">
                  Pick one or more categories that best describe your work.
                </p>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-neutral-700">Bio</label>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="Tell buyers what you do"
                  rows={4}
                  className="w-full rounded-xl border px-3 py-2"
                />
              </div>

              {/* Profile Image uploader */}
              <div className="space-y-2">
                <label className="block text-xs font-medium text-neutral-700">Profile Image</label>
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => profileImgInputRef.current?.click()}
                    className="relative h-20 w-20 overflow-hidden rounded-full border bg-neutral-50 flex items-center justify-center text-xs text-neutral-500 hover:ring-2 hover:ring-black/20"
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
                    )
                  }
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
              <div className="space-y-2">
                <label className="block text-xs font-medium text-neutral-700">Gallery Photos (4)</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {gallery.map((g, idx) => (
                    <div key={g.position} className="flex flex-col items-center gap-1">
                      <button
                        type="button"
                        onClick={() => galleryInputRefs[idx].current?.click()}
                        className="relative h-28 w-full overflow-hidden rounded-xl border bg-neutral-50 flex items-center justify-center text-xs text-neutral-500 hover:ring-2 hover:ring-black/20"
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
                        <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">Edit</span>
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
                            const res = await fetch(`${apiBase}/api/creators/me/gallery/${g.position}`, {
                              method: "PATCH",
                              credentials: "include",
                              headers: buildAuthHeaders(),
                              body: fd,
                            });
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
                <p className="text-xs text-neutral-500">These appear on the back of your creator card.</p>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={saveQuickProfile}
                  disabled={savingProfile}
                  className={`rounded-xl px-4 py-2 text-sm ${savingProfile ? "bg-neutral-300 text-neutral-600" : "bg-black text-white"
                    }`}
                >
                  {savingProfile ? "Saving…" : "Save"}
                </button>
                {saveMsg && (
                  <span
                    className={`text-sm ${saveMsg.includes("Saved") ? "text-green-700" : "text-red-700"
                      }`}
                  >
                    {saveMsg}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Pending Requests */}
          <div className="rounded-2xl border p-4">
            <div className="flex justify-between items-center mb-2">
              <div className="font-semibold">Pending Requests</div>
              <button
                onClick={() => loadPending()} // Add manual refresh
                className="text-xs text-neutral-500 hover:text-neutral-700"
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
              <div className="space-y-2 max-h-157 overflow-y-auto">
                {pendingRequests.map((req) => (
                  <div key={req.id} className="rounded-lg border p-3 bg-neutral-50 hover:bg-neutral-100 transition-colors">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <div className="text-sm font-medium">Request #{req.id}</div>
    
                        <div className="text-xs text-neutral-500 mt-1">
                          From: {req.buyer_email || req.buyer_username || "Unknown"}
                        </div>
                        {req.amount !== undefined && req.amount !== null && (
                          <div className="text-sm font-medium text-neutral-900 mt-1">
                            ${(req.amount / 100).toFixed(2)}
                          </div>
                        )}
                        <div className="text-xs text-neutral-500 mt-1">
                          {new Date(req.created_at).toLocaleDateString()} at {new Date(req.created_at).toLocaleTimeString()}
                        </div>
                      </div>
                      <div className="ml-2">
                        <button
                          onClick={() => openRequest(req)}
                          className="text-xs px-2 py-1 rounded-md bg-black text-white hover:bg-black/90"
                        >
                          View
                        </button>
                        <button
                          onClick={() => openComplete(req)}
                          className="text-xs px-2 py-1 mx-2 rounded-md bg-black text-white hover:bg-black/90"
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

        {/* ROW 2: Stripe (span 2) • Add Product (span 1) */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Stripe: left, span 2 */}
          <div className="md:col-span-1 rounded-2xl border p-4">
            <div className="font-semibold mb-2">Stripe Connect</div>

            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${stripeConnected ? "bg-green-500" : stripeConnected === false ? "bg-red-500" : "bg-neutral-300"
                  }`}
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
              className="mt-3 w-full rounded-xl bg-black py-2 text-white"
            >
              {connecting ? "Redirecting…" : stripeConnected ? "Manage in Stripe" : "Connect Stripe"}
            </button>
          </div>
          {hasMembership ? (
            <button
              type="button"
              onClick={() => router.push("/feed")}
              className="rounded-2xl border p-4 flex items-center justify-center hover:bg-neutral-50"
              aria-label="Manage feed posts"
              title="Manage feed posts"
            >
              <div className="flex flex-col items-center gap-2">
                <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-dashed">
                  <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
                <span className="text-sm font-medium">Manage in Feed</span>
              </div>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => router.push("/feed")}
              className="rounded-2xl border p-4 flex items-center justify-center hover:bg-neutral-50"
              aria-label="Manage feed posts"
              title="Manage feed posts"
            >
              <div className="flex flex-col items-center gap-2">
                <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-dashed">
                  <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
                <span className="text-sm font-medium">You do not currently have any memberships to post to.</span>
              </div>
            </button>
          )}

          {/* Add Product Icon card: right */}
          <button
            type="button"
            onClick={() => router.push("/dashboard/products/new")}
            className="rounded-2xl border p-4 flex items-center justify-center hover:bg-neutral-50"
            aria-label="Add Product"
            title="Add Product"
          >
            <div className="flex flex-col items-center gap-2">
              <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-dashed">
                <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <span className="text-sm font-medium">Add Product</span>
            </div>
          </button>
        </section>

        {/* Products grid */}
        <section>
          <h2 className="font-semibold mb-2">Your Products</h2>
          {loading ? (
            <div className="text-sm text-neutral-600">Loading…</div>
          ) : products.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {products.map((p) => (
                <div key={p.id} className="rounded-2xl border p-4">
                  <div className="text-xs uppercase tracking-wide text-neutral-600">{p.product_type}</div>
                  <div className="font-semibold">{p.title}</div>
                  {p.description && (
                    <p className="text-sm text-neutral-700 mt-1 line-clamp-3">{p.description}</p>
                  )}
                  <div className="mt-2 font-semibold">${((p.price || 0) / 100).toFixed(2)}</div>
                  <div className="mt-3 flex gap-2">
                    <button
                      className="rounded-lg border px-3 py-1 text-sm"
                      onClick={() => router.push(`/products/${p.id}`)}
                    >
                      Edit
                    </button>
                    <button
                      className="rounded-lg border px-3 py-1 text-sm"
                      onClick={() => requestDelete(p.id)}
                    >
                      Delete
                    </button>
                    <button
                      className="rounded-lg border px-3 py-1 text-sm"
                      onClick={() => openReviews(p.id)}
                    >
                      View reviews
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-neutral-600">No products yet.</div>
          )}
        </section>

        {/* Delete confirm modal */}
        {confirmDeleteId && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-5">
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
                  className="rounded-xl border px-4 py-2 text-sm"
                  disabled={deleting}
                >
                  No
                </button>
                <button
                  onClick={confirmDelete}
                  className={`rounded-xl px-4 py-2 text-sm text-white ${deleting ? "bg-neutral-400" : "bg-black"
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
            <div className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-5">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold">Request Details</h3>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-medium">From: {activeRequest.buyer_email}</div>
                {activeRequest.user && (
                  <div className="text-sm text-neutral-700"> Detail: {activeRequest.user}</div>
                )}
                
                {activeRequest.amount !== undefined && activeRequest.amount !== null && (
                  <div className="text-sm font-semibold">Amount: ${((activeRequest.amount || 0) / 100).toFixed(2)}</div>
                )}
                <div className="text-xs text-neutral-500">{new Date(activeRequest.created_at).toLocaleDateString()} at {new Date(activeRequest.created_at).toLocaleTimeString()}</div>

                {/* Download original buyer attachment (if present) */}
                {activeRequest.attachment_path ? (
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={handleDownloadAttachment}
                      className="rounded-xl border px-4 py-2 text-sm inline-flex items-center gap-2 hover:bg-neutral-50"
                    >
                      {/* Download icon */}
                      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                      </svg>
                      Download attachment
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2">
                <button onClick={closeRequest} className="rounded-xl border px-4 py-2 text-sm">Close</button>
                <button
                  onClick={() => {
                    // Open the inline Complete modal for this request
                    closeRequest();
                    openComplete(activeRequest);
                  }}
                  className="rounded-xl px-4 py-2 text-sm bg-black text-white"
                >
                  Complete
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Complete request modal (submit description + optional media) */}
        {activeCompleteRequest && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-5">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold">Complete Request</h3>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-medium text-neutral-700">Description (required)</label>
                <textarea
                  value={completeDesc}
                  onChange={(e) => setCompleteDesc(e.target.value)}
                  rows={4}
                  placeholder="Describe what you delivered or include buyer notes"
                  className="w-full rounded-xl border px-3 py-2"
                />

                <div>
                  <label className="block text-xs font-medium text-neutral-700 mb-1">Attachments (optional)</label>
                  <input ref={completeFilesRef} type="file" accept="image/*,video/*" multiple className="" />
                  <p className="text-xs text-neutral-500 mt-1">You can attach images or a short video.</p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <button onClick={closeComplete} className="rounded-xl border px-4 py-2 text-sm" disabled={completing}>Cancel</button>
                <button
                  onClick={submitComplete}
                  className={`rounded-xl px-4 py-2 text-sm text-white ${completing ? "bg-neutral-400" : "bg-black"}`}
                  disabled={completing || !completeDesc.trim()}
                >
                  {completing ? "Submitting…" : "Submit & Mark Complete"}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Reviews modal */}
        {activeReviewsProduct && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-2xl space-y-4 rounded-2xl bg-white p-5">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold">Reviews for product</h3>
                <button onClick={closeReviews} className="text-sm text-neutral-500">Close</button>
              </div>
              <div className="max-h-96 overflow-y-auto space-y-3">
                {(reviewsMap[activeReviewsProduct]?.items ?? []).length === 0 && !reviewsMap[activeReviewsProduct]?.loading ? (
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
                        <span
                          className="ml-1 inline-flex"
                          aria-label={`Rating ${r.rating} out of 5`}
                          title={`${r.rating} out of 5`}
                        >
                          {Array.from({ length: 5 }).map((_, i) => {
                            const numeric = typeof r.rating === 'number' ? r.rating : Number(r.rating || 0);
                            const filled = i < Math.round(Math.max(0, Math.min(5, numeric)));
                            return (
                              <span key={i} className={filled ? 'text-yellow-500' : 'text-neutral-300'}>
                                {filled ? '★' : '☆'}
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
                <div className="text-xs text-neutral-500">{(reviewsMap[activeReviewsProduct]?.items ?? []).length} reviews</div>
                <div>
                  {reviewsMap[activeReviewsProduct]?.loading ? (
                    <button className="rounded-xl px-3 py-1 bg-neutral-200 text-sm">Loading…</button>
                  ) : reviewsMap[activeReviewsProduct]?.hasMore ? (
                    <button
                      onClick={() => loadMoreReviews(activeReviewsProduct)}
                      className="rounded-xl px-3 py-1 bg-black text-white text-sm"
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
    </>
  );
}
