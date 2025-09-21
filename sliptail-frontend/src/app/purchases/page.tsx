"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { fetchApi } from "@/lib/api";
import { loadAuth } from "@/lib/auth";
import {
  Download, Eye, X, AlertCircle, Star, ChevronRight, Loader2,
  Calendar, CreditCard, Shield, ArrowRight
} from "lucide-react";

// Toast hook (console fallback)
function useToast() {
  return {
    // use warn so Next.js dev overlay doesn't explode
    showError: (m: string) => console.warn(m),
    showSuccess: (m: string) => console.log(m),
  };
}

type Order = {
  id: number;
  product_id: number | null;
  amount_cents: number;
  status: string;
  created_at: string;
  creator_profile: {
    user_id?: number | null;
    display_name: string;
    bio: string | null;
    profile_image: string | null;
  } | null;
  product: {
    description: string | null;
    view_url: string | null;
    download_url: string | null;
    product_type: string;
    title: string;
    filename: string;
  };
  request_response?: string | null;
  request_media_url?: string | null;

  // Buyer-submitted details (from custom_requests)
  request_id?: number | null;
  request_status?: string | null;
  request_user_message?: string | null;
  request_user_attachment_url?: string | null;

  // Membership extras
  membership_cancel_at_period_end?: boolean;
  membership_period_end?: string | null;

  // Local UI flag: hide review button after submit
  user_has_review?: boolean;
};

function resolveImageUrl(src: string | null | undefined, apiBase: string): string | null {
  if (!src) return null;
  let s = src.trim();
  if (s.startsWith("//")) s = s.slice(1);
  if (/^https?:\/\//i.test(s)) return s;
  if (!s.startsWith("/")) s = `/${s}`;
  return `${apiBase}${s}`;
}
function toApiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");
}

export default function PurchasesPage() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'memberships' | 'requests' | 'purchases'>('memberships');
  const [selectedItem, setSelectedItem] = useState<Order | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState<number | null>(null);
  const [showReviewModal, setShowReviewModal] = useState<Order | null>(null);
  const [reviewText, setReviewText] = useState("");
  const [reviewRating, setReviewRating] = useState(5);

  // inline visual toast
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const searchParams = useSearchParams();
  const router = useRouter();
  const toast = searchParams.get("toast");
  const apiBase = useMemo(() => toApiBase(), []);

  const { showSuccess, showError } = useMemo(() => useToast(), []);

  useEffect(() => {
    if (toast) setToastMsg(toast);
  }, [toast]);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 3000);
    return () => clearTimeout(t);
  }, [toastMsg]);

  useEffect(() => {
    let cancelled = false;

    const num = (v: unknown): number | null => {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const firstText = (...vals: unknown[]): string | null => {
      for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
      return null;
    };

    (async () => {
      try {
        const { token } = loadAuth();

        // 1) Orders & Memberships
        const [legacy, memberships] = await Promise.all([
          fetchApi<{ orders: any[] }>("/api/orders/mine", { method: "GET", token, cache: "no-store" }),
          fetchApi<{ memberships: any[] }>("/api/memberships/mine", { method: "GET", token, cache: "no-store" }),
        ]);

        // 2) Buyer requests (may fail or be empty; don’t block page)
        type ReqRow = {
          id: number | string;
          order_id: number | string;
          status?: string | null;
          user?: string | null;
          attachment_path?: string | null;
          creator?: string | null;
          creator_attachment_path?: string | null;
        };
        let reqs: ReqRow[] = [];
        try {
          const j = await fetchApi<{ requests: ReqRow[] }>("/api/requests/mine", { method: "GET", token, cache: "no-store" });
          reqs = j?.requests ?? [];
        } catch {
          reqs = [];
        }

        const byOrder: Record<number, ReqRow> = {};
        for (const r of reqs) {
          const k = num((r as any).order_id);
          if (k !== null) byOrder[k] = r;
        }

        // Normalize legacy orders shape
        const mappedOrders: Order[] = (legacy?.orders || []).map((o: any) => {
          const orderId = Number(o.id);
          const r = byOrder[orderId];

          return {
            id: orderId,
            product_id: o.product_id ?? (o.product?.id ?? null),
            amount_cents:
              typeof o.amount_cents === "number"
                ? o.amount_cents
                : typeof o.amount === "number"
                ? Math.round(o.amount * 100)
                : 0,
            status: String(o.status ?? "unknown"),
            created_at: String(o.created_at ?? new Date().toISOString()),
            creator_profile: o.creator_profile
              ? {
                  user_id: num(o.creator_profile.user_id),
                  display_name: String(o.creator_profile.display_name ?? ""),
                  bio: o.creator_profile.bio ?? null,
                  profile_image: o.creator_profile.profile_image ?? null,
                }
              : null,
            product: {
              description: o.product?.description ?? null,
              view_url: o.product?.view_url ?? null,
              download_url: o.product?.download_url ?? null,
              product_type: String(o.product?.product_type ?? "unknown"),
              title: String(o.product?.title ?? ""),
              filename: String(o.product?.filename ?? ""),
            },

            // Creator delivery (prefer joined request fields if present)
            request_response: firstText(o.request_response, r?.creator) ?? null,
            request_media_url:
              resolveImageUrl(firstText(o.request_media_url, r?.creator_attachment_path), apiBase) ?? null,

            // Buyer details from custom_requests
            request_id: num(r?.id),
            request_status: r?.status ?? null,
            request_user_message: firstText(r?.user),
            request_user_attachment_url: resolveImageUrl(firstText(r?.attachment_path), apiBase) ?? null,
          };
        });

        // Normalize memberships into Order-like (+ include cancel-at-period-end info)
        const membershipOrders: Order[] = (memberships?.memberships || []).map((m: any) => {
          const price =
            typeof m.product?.price === "number" ? m.product.price :
            typeof m.price === "number" ? m.price : 0;
          const priceCents = Math.round(price * 100);

          return {
            id: -Number(m.id || 0),
            product_id: m.product_id ?? (m.product?.id ?? null),
            amount_cents: priceCents,
            status: String(m.status ?? "active"),
            created_at: String(m.started_at ?? m.created_at ?? new Date().toISOString()),
            creator_profile: m.creator_profile
              ? {
                  user_id: num(m.creator_profile.user_id),
                  display_name: String(m.creator_profile.display_name ?? ""),
                  bio: m.creator_profile.bio ?? null,
                  profile_image: m.creator_profile.profile_image ?? null,
                }
              : null,
            product: {
              description: m.product?.description ?? null,
              view_url: m.product?.view_url ?? null,
              download_url: m.product?.download_url ?? null,
              product_type: "membership",
              title: String(m.product?.title ?? ""),
              filename: "",
            },
            membership_cancel_at_period_end: Boolean(m.cancel_at_period_end),
            membership_period_end: m.current_period_end ? String(m.current_period_end) : null,
          };
        });

        const combined = [...mappedOrders, ...membershipOrders].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

        if (!cancelled) setOrders(combined);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load purchases.";
        showError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiBase, showError]);

  const memberships = useMemo(
    () => orders?.filter((o) => o.product.product_type === "membership") || [],
    [orders]
  );
  const requests = useMemo(
    () => orders?.filter((o) => o.product.product_type === "request") || [],
    [orders]
  );
  const purchases = useMemo(
    () => orders?.filter((o) => o.product.product_type === "purchase") || [],
    [orders]
  );

  const handleCancelMembership = async (membershipId: number) => {
    try {
      const { token } = loadAuth();
      await fetchApi(`/api/memberships/${Math.abs(membershipId)}/cancel`, {
        method: "POST",
        token,
      });
      setShowCancelConfirm(null);
      window.location.reload();
    } catch {
      showError("Failed to cancel membership");
    }
  };

  // Low-level POST helper that returns JSON or throws with status + message
  async function postJson(path: string, body: any, token?: string | null) {
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const msg = (data?.error || data?.message || text || `HTTP ${res.status}`).trim();
      const err = new Error(msg);
      (err as any).status = res.status;
      throw err;
    }
    return data;
  }

  // Try a list of endpoints until one works; 404/405/5xx => try next; 409 duplicate => success.
  async function tryReviewEndpoints(endpoints: string[], payload: any, token?: string | null) {
    let lastErr: any = null;
    for (const ep of endpoints) {
      try {
        await postJson(ep, payload, token);
        return; // success
      } catch (e: any) {
        const status = e?.status ?? 0;
        const msg = String(e?.message || "");
        // Duplicate -> treat as success and stop trying
        if (status === 409 || /already|duplicate/i.test(msg)) return;
        // Not found / method not allowed / server error -> try next candidate
        if (status === 404 || status === 405 || status >= 500) { lastErr = e; continue; }
        // Other errors -> bubble immediately
        throw e;
      }
    }
    // If we exhausted all without success, throw the last collected error
    if (lastErr) throw lastErr;
  }

  // --- Robust review submit: try product route first, then creators, then generic fallbacks ---
  const handleSubmitReview = async () => {
    if (!showReviewModal || !reviewText.trim()) return;

    const productId = showReviewModal.product_id ?? null;
    const creatorId = showReviewModal.creator_profile?.user_id || null;

    if (!productId && !creatorId) {
      showError("Unable to determine what you’re reviewing.");
      setToastMsg("Unable to determine what you’re reviewing.");
      return;
    }

    try {
      const { token } = loadAuth();

      // Payload most backends accept (buyer_id inferred from token) + legacy key
      const payload = {
        ...(productId ? { product_id: productId } : {}),
        ...(creatorId ? { creator_id: creatorId } : {}),
        rating: reviewRating,
        comment: reviewText,
        review_text: reviewText, // legacy compat
      };

      // Candidate endpoints (most specific first)
      const endpoints: string[] = [];
      if (productId) endpoints.push(`/api/products/${productId}/reviews`);
      if (creatorId) endpoints.push(`/api/creators/${creatorId}/reviews`);
      // generic fallbacks
      endpoints.push("/api/reviews", "/api/reviews/create");

      await tryReviewEndpoints(endpoints, payload, token);

      // Close & clear
      setShowReviewModal(null);
      setReviewText("");
      setReviewRating(5);

      // Hide Review button for this item
      setOrders((prev) =>
        prev ? prev.map((o) => (o.id === showReviewModal.id ? { ...o, user_has_review: true } : o)) : prev
      );

      setToastMsg("Your review has been submitted");
      showSuccess("Your review has been submitted");
    } catch (e: any) {
      const message = e?.message ? String(e.message) : "Failed to submit review";
      setToastMsg(message);
      showError(message);
    }
  };

  const handleDownload = async (item: Order) => {
    try {
      const candidate = item.product.filename ? `uploads/${item.product.filename}` : null;
      if (!candidate) return showError("No file available to download.");

      const url = resolveImageUrl(candidate, apiBase);
      if (!url) return showError("Invalid download URL.");

      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = item.product.filename || `${item.product.title || "download"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(blobUrl);
    } catch {
      const fallback =
        item.product.download_url ||
        (item.product.filename ? resolveImageUrl(`uploads/${item.product.filename}`, apiBase) : null);
      if (fallback) window.open(fallback, "_blank", "noopener");
    }
  };

  const formatDate = (dateString: string) =>
    new Date(dateString).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const TabButton = ({
    tab,
    label,
    count,
    icon,
  }: {
    tab: typeof activeTab;
    label: string;
    count: number;
    icon: React.ReactNode;
  }) => (
    <button
      onClick={() => setActiveTab(tab)}
      className={`relative flex-1 py-4 px-6 text-sm font-medium transition-all duration-300 ${
        activeTab === tab ? "text-gray-900" : "text-gray-500 hover:text-gray-700"
      }`}
    >
      <div className="flex items-center justify-center space-x-2">
        {icon}
        <span>{label}</span>
        {count > 0 && (
          <span
            className={`ml-2 px-2 py-0.5 text-xs rounded-full ${
              activeTab === tab ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"
            }`}
          >
            {count}
          </span>
        )}
      </div>
      {activeTab === tab && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-green-600" />}
    </button>
  );

  const EmptyState = ({ message, icon }: { message: string; icon: React.ReactNode }) => (
    <div className="flex flex-col items-center justify-center py-24">
      <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-6">{icon}</div>
      <p className="text-gray-500 text-lg font-medium">{message}</p>
      <p className="text-gray-400 text-sm mt-2">Your purchases will appear here</p>
    </div>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-green-600 mx-auto mb-4" />
          <p className="text-gray-600">Loading your account...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">My Account</h1>
          <p className="text-gray-600 mt-2">Manage your memberships, requests, and purchases</p>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-xl shadow-sm mb-8">
          <div className="grid grid-cols-3 divide-x divide-gray-100">
            <TabButton tab="memberships" label="Memberships" count={memberships.length} icon={<CreditCard className="w-4 h-4" />} />
            <TabButton tab="requests" label="Requests" count={requests.length} icon={<Shield className="w-4 h-4" />} />
            <TabButton tab="purchases" label="Purchases" count={purchases.length} icon={<Download className="w-4 h-4" />} />
          </div>
        </div>

        {/* Memberships */}
        {activeTab === "memberships" && (
          <div className="space-y-6">
            {memberships.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm p-8">
                <EmptyState message="No active memberships" icon={<CreditCard className="w-10 h-10 text-gray-300" />} />
              </div>
            ) : (
              <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                {memberships.map((m) => (
                  <div key={m.id} className="bg-white rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 overflow-hidden group">
                    <div className="aspect-w-16 aspect-h-9 bg-gradient-to-br from-green-50 to-green-100 p-6">
                      <div className="flex items-center space-x-4">
                        <img
                          src={resolveImageUrl(m.creator_profile?.profile_image, apiBase) || "/sliptail-logo.png"}
                          alt={m.creator_profile?.display_name || "Creator"}
                          className="w-16 h-16 rounded-full object-cover ring-4 ring-white shadow-lg"
                        />
                        <div>
                          {m.membership_cancel_at_period_end && m.membership_period_end ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                              Active until {formatDate(m.membership_period_end)}
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              Active
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="p-6">
                      <h3 className="font-semibold text-lg text-gray-900 mb-1">{m.product.title}</h3>
                      <p className="text-sm text-gray-600 mb-4">{m.creator_profile?.display_name}</p>

                      <div className="flex items-center text-xs text-gray-500 mb-4">
                        <Calendar className="w-3 h-3 mr-1" />
                        <span>Since {formatDate(m.created_at)}</span>
                      </div>

                      <div className="space-y-3">
                        <button
                          onClick={() => router.push(`/feed?product_id=${m.product_id}`)}
                          className="w-full bg-green-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors duration-200 flex items-center justify-center group"
                        >
                          View Feed
                          <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                        </button>

                        <div className="flex space-x-2">
                          {!m.user_has_review && (
                            <button
                              onClick={() => setShowReviewModal(m)}
                              className="flex-1 text-gray-600 hover:text-gray-900 text-sm font-medium py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors duration-200 flex items-center justify-center"
                            >
                              <Star className="w-4 h-4 mr-1" />
                              Review
                            </button>
                          )}
                          {!m.membership_cancel_at_period_end && (
                            <button
                              onClick={() => setShowCancelConfirm(m.id)}
                              className="flex-1 text-red-600 hover:text-red-700 text-sm font-medium py-2 px-3 rounded-lg hover:bg-red-50 transition-colors duration-200"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Requests */}
        {activeTab === "requests" && (
          <div className="space-y-6">
            {requests.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm p-8">
                <EmptyState message="No requests yet" icon={<Shield className="w-10 h-10 text-gray-300" />} />
              </div>
            ) : (
              <div className="space-y-4">
                {requests.map((r) => {
                  const buyerSubmitted =
                    Boolean(r.request_id) ||
                    Boolean((r.request_user_message || "").trim()) ||
                    Boolean(r.request_user_attachment_url);

                  const isComplete = r.status === "complete";

                  return (
                    <div key={r.id} className="bg-white rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 p-6">
                      <div className="flex items-start space-x-4">
                        <img
                          src={resolveImageUrl(r.creator_profile?.profile_image, apiBase) || "/sliptail-logo.png"}
                          alt={r.creator_profile?.display_name || "Creator"}
                          className="w-14 h-14 rounded-full object-cover ring-2 ring-gray-100"
                        />
                        <div className="flex-1">
                          <div className="flex items-start justify-between">
                            <div>
                              <h3 className="font-semibold text-lg text-gray-900">{r.product.title}</h3>
                              <p className="text-sm text-gray-600 mt-1">{r.creator_profile?.display_name}</p>
                            </div>

                            {isComplete ? (
                              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                <div className="w-1.5 h-1.5 bg-green-600 rounded-full mr-1.5" />
                                Completed
                              </span>
                            ) : buyerSubmitted ? (
                              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                                <div className="w-1.5 h-1.5 bg-amber-600 rounded-full mr-1.5 animate-pulse" />
                                Pending
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                                <div className="w-1.5 h-1.5 bg-gray-500 rounded-full mr-1.5" />
                                Action Needed
                              </span>
                            )}
                          </div>

                          <div className="mt-4">
                            {isComplete ? (
                              <div className="flex items-center space-x-3">
                                <button
                                  onClick={() => setSelectedItem(r)}
                                  className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors duration-200 inline-flex items-center"
                                >
                                  <Eye className="w-4 h-4 mr-2" />
                                  View Response
                                </button>
                                {!r.user_has_review && (
                                  <button
                                    onClick={() => setShowReviewModal(r)}
                                    className="text-gray-600 hover:text-gray-900 text-sm font-medium py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors duration-200 inline-flex items-center"
                                  >
                                    <Star className="w-4 h-4 mr-1" />
                                    Review
                                  </button>
                                )}
                              </div>
                            ) : buyerSubmitted ? (
                              <div>
                                <p className="text-sm text-gray-500 mb-3">
                                  Waiting for creator to complete your request
                                </p>
                                <button
                                  onClick={() => setSelectedItem(r)}
                                  className="text-blue-600 hover:text-blue-700 text-sm font-medium inline-flex items-center"
                                >
                                  View Request Details
                                  <ChevronRight className="w-4 h-4 ml-1" />
                                </button>
                              </div>
                            ) : (
                              <div>
                                <p className="text-sm text-gray-500 mb-3">Please submit your request details</p>
                                <button
                                  onClick={() => router.push(`/requests/new?orderId=${r.id}`)}
                                  className="text-blue-600 hover:text-blue-700 text-sm font-medium inline-flex items-center"
                                >
                                  Submit Request Details
                                  <ChevronRight className="w-4 h-4 ml-1" />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Purchases */}
        {activeTab === "purchases" && (
          <div className="space-y-6">
            {purchases.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm p-8">
                <EmptyState message="No purchases yet" icon={<Download className="w-10 h-10 text-gray-300" />} />
              </div>
            ) : (
              <div className="grid gap-6 md:grid-cols-2">
                {purchases.map((p) => (
                  <div key={p.id} className="bg-white rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 p-6">
                    <div className="flex items-start space-x-4">
                      <img
                        src={resolveImageUrl(p.creator_profile?.profile_image, apiBase) || "/sliptail-logo.png"}
                        alt={p.creator_profile?.display_name || "Creator"}
                        className="w-14 h-14 rounded-full object-cover ring-2 ring-gray-100"
                      />
                      <div className="flex-1">
                        <h3 className="font-semibold text-lg text-gray-900">{p.product.title}</h3>
                        <p className="text-sm text-gray-600 mt-1">{p.creator_profile?.display_name}</p>

                        <div className="flex items-center text-xs text-gray-500 mt-3 mb-4">
                          <Calendar className="w-3 h-3 mr-1" />
                          <span>Purchased {formatDate(p.created_at)}</span>
                        </div>

                        <div className="flex items-center space-x-3">
                          <button
                            onClick={() => handleDownload(p)}
                            className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors duration-200 inline-flex items-center"
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Download
                          </button>
                          {!p.user_has_review && (
                            <button
                              onClick={() => setShowReviewModal(p)}
                              className="text-gray-600 hover:text-gray-900 text-sm font-medium py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors duration-200 inline-flex items-center"
                            >
                              <Star className="w-4 h-4 mr-1" />
                              Review
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Cancel Confirmation */}
        {showCancelConfirm !== null && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-8 max-w-sm w-full shadow-2xl">
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <AlertCircle className="w-6 h-6 text-red-600" />
              </div>
              <h3 className="text-xl font-semibold text-center mb-2">Cancel Membership?</h3>
              <p className="text-gray-600 text-center mb-6">
                This action cannot be undone. You'll lose access to this membership when membership expires.
              </p>
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowCancelConfirm(null)}
                  className="flex-1 bg-gray-100 text-gray-700 px-4 py-2.5 rounded-lg font-medium hover:bg-gray-200 transition-colors duration-200"
                >
                  Keep Membership
                </button>
                <button
                  onClick={() => handleCancelMembership(showCancelConfirm)}
                  className="flex-1 bg-red-600 text-white px-4 py-2.5 rounded-lg font-medium hover:bg-red-700 transition-colors duration-200"
                >
                  Yes, Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Request Detail Modal */}
        {selectedItem && selectedItem.product.product_type === "request" && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-8 max-w-2xl w-full max-h-[85vh] overflow-y-auto shadow-2xl">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-2xl font-semibold">Request Details</h3>
                <button
                  onClick={() => setSelectedItem(null)}
                  className="text-gray-400 hover:text-gray-600 p-2 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-6">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-medium text-gray-700 mb-2">Request</h4>
                  <h5 className="font-semibold text-gray-900">{selectedItem.product.title}</h5>
                  {selectedItem.product.description && (
                    <p className="text-gray-600 mt-2">{selectedItem.product.description}</p>
                  )}
                </div>

                {(selectedItem.request_user_message || selectedItem.request_user_attachment_url) && (
                  <div>
                    <h4 className="font-medium text-gray-700 mb-3">Your Submitted Details</h4>

                    {selectedItem.request_user_message && (
                      <div className="bg-gray-50 rounded-lg p-4 mb-3">
                        <p className="text-gray-700 whitespace-pre-wrap">{selectedItem.request_user_message}</p>
                      </div>
                    )}

                    {selectedItem.request_user_attachment_url && (
                      <div>
                        <h5 className="font-medium text-gray-700 mb-2">Your Attachment</h5>
                        <a
                          href={
                            resolveImageUrl(selectedItem.request_user_attachment_url, apiBase) ||
                            selectedItem.request_user_attachment_url ||
                            "#"
                          }
                          className="inline-flex items-center bg-blue-50 text-blue-700 px-4 py-2.5 rounded-lg hover:bg-blue-100 transition-colors duration-200"
                          download
                        >
                          <Download className="w-5 h-5 mr-2" />
                          Download Attachment
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {selectedItem.request_response && (
                  <div>
                    <h4 className="font-medium text-gray-700 mb-3">Creator's Response</h4>
                    <div className="bg-green-50 rounded-lg p-4">
                      <p className="text-gray-700 whitespace-pre-wrap">{selectedItem.request_response}</p>
                    </div>
                  </div>
                )}

                {selectedItem.request_media_url && (
                  <div>
                    <h4 className="font-medium text-gray-700 mb-3">Creator's Attachment</h4>
                    <a
                      href={selectedItem.request_media_url}
                      className="inline-flex items-center bg-blue-50 text-blue-700 px-4 py-2.5 rounded-lg hover:bg-blue-100 transition-colors duration-200"
                      download
                    >
                      <Download className="w-5 h-5 mr-2" />
                      Download Media
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Review Modal */}
        {showReviewModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-2xl">
              <h3 className="text-2xl font-semibold mb-6">Write a Review</h3>

              <div className="mb-6">
                <p className="text-sm font-medium text-gray-700 mb-3">How would you rate this?</p>
                <div className="flex justify-center space-x-2">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      onClick={() => setReviewRating(star)}
                      className={`text-3xl transition-colors duration-200 ${
                        star <= reviewRating ? "text-yellow-400 hover:text-yellow-500" : "text-gray-300 hover:text-gray-400"
                      }`}
                    >
                      ★
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">Share your experience</label>
                <textarea
                  value={reviewText}
                  onChange={(e) => setReviewText(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
                  rows={4}
                  placeholder="What did you think about this purchase?"
                />
              </div>

              <div className="flex space-x-3">
                <button
                  onClick={() => {
                    setShowReviewModal(null);
                    setReviewText("");
                    setReviewRating(5);
                  }}
                  className="flex-1 bg-gray-100 text-gray-700 px-4 py-2.5 rounded-lg font-medium hover:bg-gray-200 transition-colors duration-200"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmitReview}
                  disabled={!reviewText.trim()}
                  className="flex-1 bg-green-600 text-white px-4 py-2.5 rounded-lg font-medium hover:bg-green-700 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Submit Review
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Inline Toast (visual) */}
      {toastMsg && (
        <div className="fixed bottom-6 right-6 z-[60]">
          <div className="bg-green-600 text-white px-4 py-3 rounded-lg shadow-lg">
            {toastMsg}
          </div>
        </div>
      )}
    </div>
  );
}
