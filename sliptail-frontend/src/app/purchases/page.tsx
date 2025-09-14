"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchApi } from "@/lib/api";
import { loadAuth } from "@/lib/auth";
import { Download, Eye, X, AlertCircle, Star, ChevronRight, Loader2, Calendar, CreditCard, Shield, ArrowRight } from "lucide-react";

// Toast hook
function useToast() {
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
  creator_profile: {
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
  };
  // For requests
  request_response?: string | null;
  request_media_url?: string | null;
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

  const { showSuccess, showError } = useToast();
  const searchParams = useSearchParams();
  const toast = searchParams.get("toast");
  const apiBase = useMemo(() => toApiBase(), []);

  useEffect(() => {
    if (toast) showSuccess(toast);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { token } = loadAuth();

        const [legacy, memberships] = await Promise.all([
          fetchApi<{ orders: any[] }>("/api/orders/mine", {
            method: "GET",
            token,
            cache: "no-store",
          }),
          fetchApi<{ memberships: any[] }>("/api/memberships/mine", {
            method: "GET",
            token,
            cache: "no-store",
          })
        ]);

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
          creator_profile: o.creator_profile
            ? {
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
          },
          request_response: o.request_response ?? null,
          request_media_url: o.request_media_url ?? null,
        }));

        const membershipOrders: Order[] = (memberships?.memberships || []).map((m: any) => {
          const price = typeof m.product?.price === 'number' ? m.product.price : 0;
          const priceCents = Math.round(price * 100);

          return {
            id: -Number(m.id || 0),
            product_id: m.product_id ?? (m.product?.id ?? null),
            amount_cents: priceCents,
            status: String(m.status ?? 'active'),
            created_at: String(m.started_at ?? m.created_at ?? new Date().toISOString()),
            creator_profile: m.creator_profile
              ? {
                display_name: String(m.creator_profile.display_name ?? ''),
                bio: m.creator_profile.bio ?? null,
                profile_image: m.creator_profile.profile_image ?? null,
              }
              : null,
            product: {
              description: m.product?.description ?? null,
              view_url: m.product?.view_url ?? null,
              download_url: m.product?.download_url ?? null,
              product_type: 'membership',
              title: String(m.product?.title ?? ''),
            },
          };
        });

        const combined: Order[] = [...mapped, ...membershipOrders].sort(
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
    return () => { cancelled = true; };
  }, []);

  const memberships = useMemo(() =>
    orders?.filter(o => o.product.product_type === 'membership') || [],
    [orders]);

  const requests = useMemo(() =>
    orders?.filter(o => o.product.product_type === 'request') || [],
    [orders]);

  const purchases = useMemo(() =>
    orders?.filter(o => o.product.product_type === 'purchase') || [],
    [orders]);

  const handleCancelMembership = async (membershipId: number) => {
    try {
      const { token } = loadAuth();
      await fetchApi(`/api/memberships/${Math.abs(membershipId)}/cancel`, {
        method: "POST",
        token,
      });
      showSuccess("Membership cancelled successfully");
      setShowCancelConfirm(null);
      // Refresh data
      window.location.reload();
    } catch (e) {
      showError("Failed to cancel membership");
    }
  };

  const handleSubmitReview = async () => {
    if (!showReviewModal || !reviewText.trim()) return;

    try {
      const { token } = loadAuth();
      await fetchApi("/api/reviews/create", {
        method: "POST",
        token,
        body: {
          product_id: showReviewModal.product_id,
          rating: reviewRating,
          review_text: reviewText,
        },
      });
      showSuccess("Review submitted successfully");
      setShowReviewModal(null);
      setReviewText("");
      setReviewRating(5);
    } catch (e) {
      showError("Failed to submit review");
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const TabButton = ({ tab, label, count, icon }: {
    tab: typeof activeTab,
    label: string,
    count: number,
    icon: React.ReactNode
  }) => (
    <button
      onClick={() => setActiveTab(tab)}
      className={`relative flex-1 py-4 px-6 text-sm font-medium transition-all duration-300 ${activeTab === tab
        ? 'text-gray-900'
        : 'text-gray-500 hover:text-gray-700'
        }`}
    >
      <div className="flex items-center justify-center space-x-2">
        {icon}
        <span>{label}</span>
        {count > 0 && (
          <span className={`ml-2 px-2 py-0.5 text-xs rounded-full ${activeTab === tab
            ? 'bg-green-100 text-green-700'
            : 'bg-gray-100 text-gray-600'
            }`}>
            {count}
          </span>
        )}
      </div>
      {activeTab === tab && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-green-600" />
      )}
    </button>
  );

  const EmptyState = ({ message, icon }: { message: string, icon: React.ReactNode }) => (
    <div className="flex flex-col items-center justify-center py-24">
      <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-6">
        {icon}
      </div>
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

        {/* Tab Navigation */}
        <div className="bg-white rounded-xl shadow-sm mb-8">
          <div className="grid grid-cols-3 divide-x divide-gray-100">
            <TabButton
              tab="memberships"
              label="Memberships"
              count={memberships.length}
              icon={<CreditCard className="w-4 h-4" />}
            />
            <TabButton
              tab="requests"
              label="Requests"
              count={requests.length}
              icon={<Shield className="w-4 h-4" />}
            />
            <TabButton
              tab="purchases"
              label="Purchases"
              count={purchases.length}
              icon={<Download className="w-4 h-4" />}
            />
          </div>
        </div>

        {/* Memberships Section */}
        {activeTab === 'memberships' && (
          <div className="space-y-6">
            {memberships.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm p-8">
                <EmptyState
                  message="No active memberships"
                  icon={<CreditCard className="w-10 h-10 text-gray-300" />}
                />
              </div>
            ) : (
              <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                {memberships.map((membership) => (
                  <div key={membership.id} className="bg-white rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 overflow-hidden group">
                    <div className="aspect-w-16 aspect-h-9 bg-gradient-to-br from-green-50 to-green-100 p-6">
                      <div className="flex items-center space-x-4">
                        <img
                          src={resolveImageUrl(membership.creator_profile?.profile_image, apiBase) || "/sliptail-logo.png"}
                          alt={membership.creator_profile?.display_name || "Creator"}
                          className="w-16 h-16 rounded-full object-cover ring-4 ring-white shadow-lg"
                        />
                        <div>
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                            Active
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="p-6">
                      <h3 className="font-semibold text-lg text-gray-900 mb-1">{membership.product.title}</h3>
                      <p className="text-sm text-gray-600 mb-4">{membership.creator_profile?.display_name}</p>

                      <div className="flex items-center text-xs text-gray-500 mb-4">
                        <Calendar className="w-3 h-3 mr-1" />
                        <span>Since {formatDate(membership.created_at)}</span>
                      </div>

                      <div className="space-y-3">
                        <button
                          onClick={() => window.location.href = `/feed/${membership.product_id}`}
                          className="w-full bg-green-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors duration-200 flex items-center justify-center group"
                        >
                          View Feed
                          <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                        </button>

                        <div className="flex space-x-2">
                          <button
                            onClick={() => setShowReviewModal(membership)}
                            className="flex-1 text-gray-600 hover:text-gray-900 text-sm font-medium py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors duration-200 flex items-center justify-center"
                          >
                            <Star className="w-4 h-4 mr-1" />
                            Review
                          </button>
                          <button
                            onClick={() => setShowCancelConfirm(membership.id)}
                            className="flex-1 text-red-600 hover:text-red-700 text-sm font-medium py-2 px-3 rounded-lg hover:bg-red-50 transition-colors duration-200"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Requests Section */}
        {activeTab === 'requests' && (
          <div className="space-y-6">
            {requests.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm p-8">
                <EmptyState
                  message="No requests yet"
                  icon={<Shield className="w-10 h-10 text-gray-300" />}
                />
              </div>
            ) : (
              <div className="space-y-4">
                {requests.map((request) => (
                  <div key={request.id} className="bg-white rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 p-6">
                    <div className="flex items-start space-x-4">
                      <img
                        src={resolveImageUrl (request.creator_profile?.profile_image, apiBase) || "/sliptail-logo.png"}
                        alt={request.creator_profile?.display_name || "Creator"}
                        className="w-14 h-14 rounded-full object-cover ring-2 ring-gray-100"
                      />
                      <div className="flex-1">
                        <div className="flex items-start justify-between">
                          <div>
                            <h3 className="font-semibold text-lg text-gray-900">{request.product.title}</h3>
                            <p className="text-sm text-gray-600 mt-1">{request.creator_profile?.display_name}</p>
                          </div>
                          {request.status === 'paid' ? (
                            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              <div className="w-1.5 h-1.5 bg-green-600 rounded-full mr-1.5" />
                              Completed
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                              <div className="w-1.5 h-1.5 bg-amber-600 rounded-full mr-1.5 animate-pulse" />
                              Pending
                            </span>
                          )}
                        </div>

                        <div className="mt-4">
                          {request.status === 'paid' ? (
                            <div className="flex items-center space-x-3">
                              <button
                                onClick={() => setSelectedItem(request)}
                                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors duration-200 inline-flex items-center"
                              >
                                <Eye className="w-4 h-4 mr-2" />
                                View Response
                              </button>
                              <button
                                onClick={() => setShowReviewModal(request)}
                                className="text-gray-600 hover:text-gray-900 text-sm font-medium py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors duration-200 inline-flex items-center"
                              >
                                <Star className="w-4 h-4 mr-1" />
                                Review
                              </button>
                            </div>
                          ) : (
                            <div>
                              <p className="text-sm text-gray-500 mb-3">Waiting for creator to complete your request</p>
                              <button className="text-blue-600 hover:text-blue-700 text-sm font-medium inline-flex items-center">
                                Submit Request Details
                                <ChevronRight className="w-4 h-4 ml-1" />
                              </button>
                            </div>
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

        {/* Purchases Section */}
        {activeTab === 'purchases' && (
          <div className="space-y-6">
            {purchases.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm p-8">
                <EmptyState
                  message="No purchases yet"
                  icon={<Download className="w-10 h-10 text-gray-300" />}
                />
              </div>
            ) : (
              <div className="grid gap-6 md:grid-cols-2">
                {purchases.map((purchase) => (
                  <div key={purchase.id} className="bg-white rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 p-6">
                    <div className="flex items-start space-x-4">
                      <img
                        src={resolveImageUrl(purchase.creator_profile?.profile_image, apiBase) || "/sliptail-logo.png"}
                        alt={purchase.creator_profile?.display_name || "Creator"}
                        className="w-14 h-14 rounded-full object-cover ring-2 ring-gray-100"
                      />
                      <div className="flex-1">
                        <h3 className="font-semibold text-lg text-gray-900">{purchase.product.title}</h3>
                        <p className="text-sm text-gray-600 mt-1">{purchase.creator_profile?.display_name}</p>

                        <div className="flex items-center text-xs text-gray-500 mt-3 mb-4">
                          <Calendar className="w-3 h-3 mr-1" />
                          <span>Purchased {formatDate(purchase.created_at)}</span>
                        </div>

                        <div className="flex items-center space-x-3">
                          <a
                            href={(purchase.product.download_url ? resolveImageUrl(purchase.product.download_url, apiBase) : '#')}
                            className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors duration-200 inline-flex items-center"
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Download
                          </a>
                          <button
                            onClick={() => setShowReviewModal(purchase)}
                            className="text-gray-600 hover:text-gray-900 text-sm font-medium py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors duration-200 inline-flex items-center"
                          >
                            <Star className="w-4 h-4 mr-1" />
                            Review
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Cancel Confirmation Modal */}
        {showCancelConfirm !== null && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-8 max-w-sm w-full shadow-2xl">
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <AlertCircle className="w-6 h-6 text-red-600" />
              </div>
              <h3 className="text-xl font-semibold text-center mb-2">Cancel Membership?</h3>
              <p className="text-gray-600 text-center mb-6">This action cannot be undone. You'll lose access to this membership immediately.</p>
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
        {selectedItem && selectedItem.product.product_type === 'request' && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-8 max-w-2xl w-full max-h-[85vh] overflow-y-auto shadow-2xl">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-2xl font-semibold">Request Response</h3>
                <button
                  onClick={() => setSelectedItem(null)}
                  className="text-gray-400 hover:text-gray-600 p-2 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="space-y-6">
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-medium text-gray-700 mb-2">Your Request</h4>
                  <h5 className="font-semibold text-gray-900">{selectedItem.product.title}</h5>
                  {selectedItem.product.description && (
                    <p className="text-gray-600 mt-2">{selectedItem.product.description}</p>
                  )}
                </div>

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
                    <h4 className="font-medium text-gray-700 mb-3">Attached Files</h4>
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
                      className={`text-3xl transition-colors duration-200 ${star <= reviewRating
                        ? 'text-yellow-400 hover:text-yellow-500'
                        : 'text-gray-300 hover:text-gray-400'
                        }`}
                    >
                      ★
                    </button>
                  ))}
                </div>
              </div>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Share your experience
                </label>
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
    </div>
  );
}