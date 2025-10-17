"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { fetchApi } from "@/lib/api";
import { loadAuth } from "@/lib/auth";

interface Product { id: number; creator_id: number; title: string | null; description: string | null; created_at?: string; display_name?: string; profile_image?: string; }
interface Post { id: number; creator_id: number; title: string | null; body: string | null; media_path: string | null; media_poster?: string | null; created_at: string; product_id?: number; profile_image?: string; }
interface MeResponse { user?: { id: number; role?: string; }; }

function resolveImageUrl(src: string | null | undefined, apiBase: string): string | null {
  if (!src) return null;
  let s = src.trim();
  if (s.startsWith("//")) s = s.slice(1);
  if (/^https?:\/\//i.test(s)) return s;
  if (!s.startsWith("/")) s = `/${s}`;
  return `${apiBase}${s}`;
}

function PostMedia({
  src,
  file = null,
  bleed = false,
  poster,
}: {
  src: string;
  file?: File | null;
  bleed?: boolean;
  poster?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const overlayTimerRef = useRef<number | undefined>(undefined);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedFrac, setBufferedFrac] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [showPosterOverlay, setShowPosterOverlay] = useState(true);
  const [resolvedPoster, setResolvedPoster] = useState<string | null>(null);
  
  // Use provided poster directly (already signed by backend)
  const effectivePoster = useMemo(() => {
    if (poster && poster.trim()) {
      console.log('[PostMedia] Using poster from API:', poster);
      return poster;
    }
    // If no poster provided, let browser show first frame with preload="metadata"
    console.log('[PostMedia] No poster, browser will load first frame for:', src);
    return undefined;
  }, [poster, src]);

  // Resolve poster via fetch (handles protected endpoints with credentials)
  useEffect(() => {
    let revoke: string | null = null;
    setResolvedPoster(null);
    const url = poster?.trim();
    if (!url) return;
    (async () => {
      try {
        const res = await fetch(url, { credentials: "include", cache: "no-store" });
        if (!res.ok) return;
        const ct = res.headers.get("content-type") || "";
        if (!ct.toLowerCase().startsWith("image/")) return;
        const blob = await res.blob();
        const obj = URL.createObjectURL(blob);
        revoke = obj;
        setResolvedPoster(obj);
      } catch {}
    })();
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [poster]);

  // Ensure inline playback on iPhone Safari
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.setAttribute("playsinline", "true");
      // iOS Safari specific
      v.setAttribute("webkit-playsinline", "true");
      // Some Android WebViews (optional, harmless elsewhere)
      v.setAttribute("x5-playsinline", "true");
      // Ensure not auto-playing or showing a black frame before interaction
      v.pause();
    } catch {}
  }, []);

  const isAudio =
    (file?.type?.startsWith("audio/") ||
      /\.mp3$/i.test((src || "").split("?")[0])) as boolean;
  const isVideo =
    (file?.type?.startsWith("video/") ||
      /\.(mp4|webm|ogg|m4v|mov)$/i.test((src || "").split("?")[0])) as boolean;

  const clearOverlayTimer = () => {
    if (overlayTimerRef.current !== undefined) {
      window.clearTimeout(overlayTimerRef.current);
      overlayTimerRef.current = undefined;
    }
  };

  const scheduleOverlayAutoHide = useCallback((delay = 1500) => {
    clearOverlayTimer();
    overlayTimerRef.current = window.setTimeout(() => {
      setOverlayVisible(false);
      overlayTimerRef.current = undefined;
    }, delay);
  }, []);

  const toggleVideoPlayback = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, []);

  const formatTime = (t: number) => {
    if (!isFinite(t) || t < 0) t = 0;
    const total = Math.floor(t);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const updateBuffered = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.duration || !isFinite(v.duration)) {
      setBufferedFrac(0);
      return;
    }
    try {
      const len = v.buffered?.length || 0;
      if (len > 0) {
        const end = v.buffered.end(len - 1);
        setBufferedFrac(Math.max(0, Math.min(1, end / v.duration)));
      } else {
        setBufferedFrac(0);
      }
    } catch {
      setBufferedFrac(0);
    }
  }, []);

  const getFracFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || !duration) return 0;
    const rect = el.getBoundingClientRect();
    const frac = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, frac));
  };

  const seekToFraction = (frac: number) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    const newTime = frac * duration;
    v.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handleScrubStart = (clientX: number) => {
    setSeeking(true);
    clearOverlayTimer();
    setOverlayVisible(true);
    seekToFraction(getFracFromClientX(clientX));
  };

  const handleScrubMove = (clientX: number) => {
    if (!seeking) return;
    seekToFraction(getFracFromClientX(clientX));
  };

  const handleScrubEnd = () => {
    setSeeking(false);
    if (isPlaying) scheduleOverlayAutoHide();
  };

  if (isAudio) {
    return (
      <div className="mt-3">
        {/* On mobile, cancel the post row’s horizontal padding so audio can span
           the whole card; on sm+ keep it centered/capped. */}
        <div className={`${bleed ? "-mx-4 sm:mx-0" : ""} sm:mx-auto sm:max-w-2xl`}>
          <audio
            src={src}
            controls
            preload="metadata"
            controlsList="nodownload"
            className="block w-full"
          />
        </div>
      </div>
    );
  }

  // ---- IMAGE / VIDEO (unchanged) ----
  return (
    <div className="mt-3 flex justify-center">
      <div className="w-full md:w-auto max-w-3xl rounded-xl overflow-hidden ring-1 ring-neutral-200">
        {isVideo ? (
          <div
            className="relative group"
            onMouseEnter={() => isPlaying && setOverlayVisible(true)}
            onMouseMove={() => {
              if (isPlaying) {
                setOverlayVisible(true);
                scheduleOverlayAutoHide();
              }
            }}
            onMouseLeave={() => isPlaying && setOverlayVisible(false)}
            onPointerDown={() => {
              // On touch or pen/mouse down, reveal overlay briefly while playing
              if (isPlaying) {
                setOverlayVisible(true);
                scheduleOverlayAutoHide(1800);
              }
            }}
            onClick={() => {
              // Clicking the video area shows the overlay while playing
              if (isPlaying) {
                setOverlayVisible(true);
                scheduleOverlayAutoHide();
              }
            }}
          >
            <video
              ref={videoRef}
              src={src}
              playsInline
              preload="metadata"
              crossOrigin="use-credentials"
              poster={effectivePoster}
              onLoadedMetadata={() => {
                const v = videoRef.current;
                const d = v?.duration || 0;
                setDuration(isFinite(d) ? d : 0);
                updateBuffered();
                console.log('[PostMedia] Video metadata loaded, duration:', d, 'poster:', effectivePoster);
              }}
              onTimeUpdate={() => {
                const v = videoRef.current;
                if (!v) return;
                if (!seeking) setCurrentTime(v.currentTime || 0);
              }}
              onProgress={updateBuffered}
              onError={(e) => {
                console.error('[PostMedia] Video error:', e);
                const v = videoRef.current;
                if (v) {
                  console.error('[PostMedia] Video src:', v.currentSrc);
                  console.error('[PostMedia] Video poster:', v.poster);
                  console.error('[PostMedia] Video error code:', v.error?.code, v.error?.message);
                }
              }}
              onPlay={() => {
                setIsPlaying(true);
                setShowPosterOverlay(false);
                setOverlayVisible(false);
                scheduleOverlayAutoHide(1200);
              }}
              onPause={() => {
                setIsPlaying(false);
                clearOverlayTimer();
                setOverlayVisible(true);
                const v = videoRef.current;
                // Show poster again if at the beginning
                if (v && (v.currentTime ?? 0) <= 0.01) {
                  setShowPosterOverlay(Boolean(resolvedPoster || effectivePoster));
                }
              }}
              onEnded={() => {
                setIsPlaying(false);
                clearOverlayTimer();
                setOverlayVisible(true);
                setShowPosterOverlay(Boolean(resolvedPoster || effectivePoster));
                setCurrentTime(0);
              }}
              className="w-full md:w-auto h-auto max-h-[70vh] md:max-h-[65vh] lg:max-h-[60vh] bg-black object-contain"
            />
            
            {/* Poster image overlay for mobile - shown before video plays */}
            {showPosterOverlay && (resolvedPoster || effectivePoster) && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={resolvedPoster || effectivePoster}
                  alt="video preview"
                  className="absolute inset-0 w-full h-auto max-h-[70vh] md:max-h-[65vh] lg:max-h-[60vh] object-contain bg-black pointer-events-none select-none"
                />
              </>
            )}
            
            {/* Centered Play/Pause overlay */}
            {(overlayVisible || !isPlaying) && (
              <button
                type="button"
                aria-label={isPlaying ? "Pause video" : "Play video"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleVideoPlayback();
                }}
                className="absolute z-10 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 inline-flex items-center justify-center h-14 w-14 rounded-full bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 focus:outline-none focus:ring-2 focus:ring-white/60"
              >
                {/* Icon */}
                {isPlaying ? (
                  // Pause icon
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="5" y="4" width="5" height="16" rx="1"></rect>
                    <rect x="14" y="4" width="5" height="16" rx="1"></rect>
                  </svg>
                ) : (
                  // Play icon
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M8 5v14l11-7-11-7z"></path>
                  </svg>
                )}
              </button>
            )}

            {/* Bottom time control (timeline) */}
            <div className="absolute inset-x-0 bottom-0 p-3 select-none z-10">
              <div
                className={`rounded-md px-2 py-1.5 bg-black/45 backdrop-blur-sm text-white shadow transition-opacity ${
                  overlayVisible || !isPlaying ? "opacity-100" : "opacity-0"
                }`}
              >
                <div className="flex items-center gap-3">
                  {/* Current time */}
                  <span className="text-[11px] tabular-nums min-w-[36px] text-white/90">{formatTime(currentTime)}</span>

                  {/* Track */}
                  <div
                    ref={trackRef}
                    className="relative h-2 flex-1 cursor-pointer touch-none"
                    onPointerDown={(e) => {
                      pointerIdRef.current = e.pointerId;
                      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                      handleScrubStart(e.clientX);
                    }}
                    onPointerMove={(e) => {
                      if (pointerIdRef.current !== null) {
                        e.preventDefault();
                        handleScrubMove(e.clientX);
                      }
                    }}
                    onPointerUp={() => {
                      pointerIdRef.current = null;
                      handleScrubEnd();
                    }}
                    onPointerCancel={() => {
                      pointerIdRef.current = null;
                      handleScrubEnd();
                    }}
                  >
                    <div className="absolute inset-0 rounded-full bg-white/20" />
                    {/* Buffered */}
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-white/35"
                      style={{ width: `${Math.max(0, Math.min(100, bufferedFrac * 100))}%` }}
                    />
                    {/* Played */}
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-emerald-400"
                      style={{ width: `${duration ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0}%` }}
                    />
                    {/* Thumb */}
                    <div
                      className="absolute -top-1.5 h-5 w-5 rounded-full bg-white shadow ring-1 ring-black/10"
                      style={{ left: `${duration ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0}%`, transform: "translateX(-50%)" }}
                    />
                  </div>

                  {/* Duration */}
                  <span className="text-[11px] tabular-nums min-w-[36px] text-white/90">{formatTime(duration)}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <img
            src={src}
            alt="post media"
            loading="lazy"
            className="block w-full md:w-auto h-auto max-h-[70vh] md:max-h-[65vh] lg:max-h-[60vh] mx-auto"
          />
        )}
      </div>
    </div>
  );
}

export default function MembershipFeedPage() {
  const [{ token }] = useState(() => loadAuth());
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [tab, setTab] = useState<"mine" | "others">("mine");
  const [isCreator, setIsCreator] = useState<boolean>(false);
  const [otherProducts, setOtherProducts] = useState<Product[]>([]);
  const [expandedProductId, setExpandedProductId] = useState<number | null>(null);
  const [editingPost, setEditingPost] = useState<Post | null>(null);
  const [deletingPost, setDeletingPost] = useState<Post | null>(null);
  const [addingProduct, setAddingProduct] = useState<Product | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [addingSaving, setAddingSaving] = useState(false);
  const [deletingSaving, setDeletingSaving] = useState(false);
  // media re-upload state (UI only for now)
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const [draftMediaPreview, setDraftMediaPreview] = useState<string | null>(null);
  const [mediaRemoved, setMediaRemoved] = useState(false); // track explicit removal in edit

  // Get product ID from URL parameters (for direct linking to specific membership)
  const productIdParam = searchParams.get('product_id');
  const highlightProductId = productIdParam ? parseInt(productIdParam, 10) : null;

  // cleanup object URL when component unmounts or preview changes
  useEffect(() => {
    return () => { if (draftMediaPreview?.startsWith("blob:")) URL.revokeObjectURL(draftMediaPreview); };
  }, [draftMediaPreview]);

  const apiBase = useMemo(
    () => (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, ""),
    []
  );

  // Resolve media URL: keep blob: URLs as-is; otherwise resolve against API base
  const resolveMediaUrl = useCallback(
    (src: string | null | undefined): string | null => {
      if (!src) return null;
      const s = src.trim();
      if (s.startsWith("blob:")) return s; // local object URL
      return resolveImageUrl(s, apiBase);
    },
    [apiBase]
  );

  // Determine if media should be rendered as a video
  const isVideoMedia = useCallback(
    (file: File | null, src: string | null | undefined): boolean => {
      if (file?.type) return file.type.startsWith("video/");
      const s = (src || "").toLowerCase().split("?")[0].split("#")[0];
      return /\.(mp4|webm|ogg|m4v|mov)$/i.test(s);
    },
    []
  );
   const isAudioMedia = useCallback(
   (file: File | null, src: string | null | undefined): boolean => {
     if (file?.type) return file.type.startsWith("audio/");
     const s = (src || "").toLowerCase().split("?")[0].split("#")[0];
     return /\.mp3$/i.test(s);
  },
   []
 );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
        // determine role (works with cookie or Bearer)
            try {
              const me = await fetchApi<MeResponse>("/api/me", { method: "GET", token, cache: "no-store" });
              const role = me.user?.role?.toLowerCase();
              setIsCreator(role === "creator");
              if (role !== "creator") setTab("others");
            } catch {
              setIsCreator(false);
              setTab("others");
            }
      const prods = await fetchApi<{ products: Product[] }>("/api/memberships/feed", { method: "GET", token, cache: "no-store" })
        .then(r => r.products || []);
      setProducts(prods);
      const subscribed = await fetchApi<{ products: Product[] }>("/api/memberships/subscribed-products", { method: "GET", token, cache: "no-store" })
        .then(r => r.products || []);
      setOtherProducts(subscribed);

      console.log("Feed products found:", subscribed);

      const allProducts = [...prods, ...subscribed];
      if (allProducts.length) {
        const arrays = await Promise.all(allProducts.map(p => fetchApi<{ posts: Post[] }>(`/api/posts/product/${p.id}`, { method: "GET", token, cache: "no-store" })
          .then(r => (r.posts || []).map(post => ({ ...post })))
          .catch(() => [])
        ));
        const merged = arrays.flat();
        merged.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
        setPosts(merged);
      } else {
        setPosts([]);
      }
    } catch (e: any) {
      if (typeof e?.message === "string" && e.message.toLowerCase().includes("unauthorized")) {
        setError("Unauthorized. Please sign in.");
      } else {
        setError(e?.message || "Failed to load feed.");
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // Auto-expand and switch to correct tab when product_id is provided in URL
  useEffect(() => {
    if (highlightProductId && !loading) {
      // Check if product is in current user's products (mine tab)
      const isMyProduct = products.some(p => p.id === highlightProductId);
      // Check if product is in subscribed products (others tab)
      const isOtherProduct = otherProducts.some(p => p.id === highlightProductId);
      
      if (isMyProduct) {
        setTab("mine");
        setExpandedProductId(highlightProductId);
      } else if (isOtherProduct) {
        setTab("others");
        setExpandedProductId(highlightProductId);
      }
    }
  }, [highlightProductId, loading, products, otherProducts]);

  // Posts grouped by product id directly
  const postsByProd = useMemo(() => {
    const map: Record<number, Post[]> = {};
    posts.forEach(p => {
      if (!p.product_id) return; // ignore stray posts without product reference
      (map[p.product_id] ||= []).push(p);
    });

    Object.values(map).forEach(arr => arr.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)));
    return map;
  }, [posts]);

  // For other creators' membership products we only list products; fetching their posts would require additional access logic.
  // Placeholder for possible future: fetch posts for otherProducts similar to own products once API allows.
  const otherPosts: Post[] = [];

  const handleAdd = (product: Product) => {
    setAddingProduct(product);
    setDraftTitle("");
    setDraftBody("");
    setDraftFile(null);
    setDraftMediaPreview(null);
  };
  const handleEdit = (post: Post) => {
    setEditingPost(post);
    setDraftTitle(post.title || "");
    setDraftBody(post.body || "");
    setDraftFile(null);
    setDraftMediaPreview(post.media_path || null);
    setMediaRemoved(false);
  };
  const handleDelete = (post: Post) => {
    setDeletingPost(post);
  };

  const resetDraftMedia = () => {
    if (draftMediaPreview && draftMediaPreview.startsWith("blob:")) URL.revokeObjectURL(draftMediaPreview);
    
    setDraftFile(null);
    setDraftMediaPreview(null);
    if (editingPost) setMediaRemoved(true); // only matters in edit context
  };

  const closeEdit = () => { setEditingPost(null); setDraftTitle(""); setDraftBody(""); resetDraftMedia(); setMediaRemoved(false); };
  const closeDelete = () => { setDeletingPost(null); };
  const closeAdd = () => { setAddingProduct(null); setDraftTitle(""); setDraftBody(""); resetDraftMedia(); };

  const saveEdit = async () => {
    if (!editingPost) return;
    try {
      const changedMedia = draftFile != null; // blob indicates new upload
      const fd = new FormData();
      fd.append("title", draftTitle.trim());
      fd.append("body", draftBody.trim());
      if (changedMedia && draftFile) fd.append("media", draftFile);
      if (!changedMedia && mediaRemoved && !draftMediaPreview) {
        fd.append("media_remove", "1");
      }
      const updated = await fetchApi<{ post: Post }>(`/api/posts/${editingPost.id}`, { method: "PUT", token, body: fd });
      setPosts(prev => prev.map(p => p.id === editingPost.id ? updated.post : p));
      closeEdit();
    } catch (e: any) {
      setError(e?.message || "Failed to update post");
    }
  };

  const saveAdd = async () => {
    if (!addingProduct) return;
    setAddingSaving(true);
    try {
      const fd = new FormData();
      fd.append("product_id", String(addingProduct.id));
      fd.append("title", draftTitle.trim());
      fd.append("body", draftBody.trim());
      if (draftFile) fd.append("media", draftFile);
      const res = await fetchApi<{ post: Post }>("/api/posts", { method: "POST", token, body: fd });
      if (res?.post) {
        setPosts(prev => [res.post, ...prev]);
      }
      closeAdd();
    } catch (e: any) {
      setError(e?.message || "Failed to create post.");
    } finally {
      setAddingSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deletingPost) return;
    setDeletingSaving(true);
    try {
      await fetchApi(`/api/posts/${deletingPost.id}`, { method: "DELETE", token });
      setPosts(prev => prev.filter(p => p.id !== deletingPost.id));
      closeDelete();
    } catch (e: any) {
      setError(e?.message || "Failed to delete post");
    } finally {
      setDeletingSaving(false);
    }
  };

  const onSelectFile = (file: File) => {
    resetDraftMedia();
    const url = URL.createObjectURL(file);
    console.log("Selected file:", url);

    setDraftFile(file);
    setDraftMediaPreview(url);
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onSelectFile(f);
  };

  return (
    <div className="relative overflow-hidden min-h-screen bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400">
          <main className="max-w-5xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Membership Feed</h1>
      </div>
      {isCreator && (
        <div className="inline-flex rounded-full border bg-neutral-50 p-1 text-sm">

          <button onClick={() => setTab("mine")} className={`px-4 py-1.5 rounded-full transition font-medium ${tab === "mine" ? "cursor-pointer bg-white shadow-sm text-neutral-900" : "cursor-pointer text-neutral-500 hover:text-neutral-800"}`}>My Posts</button>

          <button onClick={() => setTab("others")} className={`px-4 py-1.5 rounded-full transition font-medium ${tab === "others" ? "cursor-pointer bg-white shadow-sm text-neutral-900" : "cursor-pointer text-neutral-500 hover:text-neutral-800"}`}>Other Posts</button>
        </div>)}

      {loading && <div className="text-sm text-neutral-600">Loading...</div>}
      {/* {!loading && !token && <div className="text-sm text-neutral-600">Not signed in.</div>} */}
      {error && <div className="text-sm text-red-600">{error}</div>}

      {isCreator && tab === "mine" && (
        <div className="space-y-6">
          {products.map(prod => {
            const creatorPosts = postsByProd[prod.id] || [];
            const expanded = expandedProductId === prod.id;
            const isHighlighted = highlightProductId === prod.id;
            return (
              <div key={prod.id}
                  className={`rounded-2xl overflow-hidden ${isHighlighted ? 'bg-green-50 border border-green-200 shadow-lg' : 'bg-white ring-1 ring-black/5'} transition-all duration-300`}
                >
                <div className={`flex items-center gap-3 px-4 py-3 ${isHighlighted ? 'bg-green-100/70' : 'bg-neutral-50/70'} border-b`}>
              <button
                  aria-expanded={expanded}
                  onClick={() => setExpandedProductId(prev => prev === prod.id ? null : prod.id)}
                  className="cursor-pointer relative flex-1 min-w-0 text-left"
                >
                  <h2 className="font-bold text-base md:text-lg leading-tight truncate">
                    {prod.title || `Product #${prod.id}`}
                  </h2>
                  <p className="text-xs text-neutral-500">
                    {prod.created_at && <>  {new Date(prod.created_at).toLocaleDateString()}</>}
                  </p>

                  {/* Mobile: inline hint below content */}
                  <div className="mt-1 text-sm font-semibold text-neutral-700 sm:hidden">
                    {expanded ? "Tap to Close" : "Tap to Open"}
                  </div>

                  {/* sm+ : centered overlay hint */}
                  <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 hidden sm:block sm:text-base md:text-lg font-semibold text-neutral-700">
                    {expanded ? "Tap to Close" : "Tap to Open"}
                  </span>
                </button>
                  {isCreator && <button onClick={() => handleAdd(prod)} className="cursor-pointer text-xs px-3 py-1 rounded-full bg-blue-600 text-white hover:bg-blue-500 active:scale-[.96] transition">Add Post</button>}
                </div>
                {expanded && (
                  <div>
                    {creatorPosts.length === 0 && (
                      <div className="p-5 text-sm text-neutral-500 flex items-center gap-3">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-400">∅</span>
                        <span>No posts yet. Click Add Post to create one.</span>
                      </div>
                    )}
                    {creatorPosts.map(post => (
                      <div key={post.id} className="p-4 border-t flex gap-3 hover:bg-neutral-50 transition group">

                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-xs text-neutral-500 flex-wrap">
                                <span>{new Date(post.created_at).toLocaleString()}</span>
                              </div>
                              {post.title && <h3 className="font-bold text-base md:text-lg mt-1 leading-snug break-words">Title: {post.title}</h3>}
                            </div>
                            {isCreator && (
                              <div className="flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition">
                                <button onClick={() => handleEdit(post)} className="text-[10px] px-2 py-1 border rounded hover:bg-neutral-100">Edit</button>
                                <button onClick={() => handleDelete(post)} className="text-[10px] px-2 py-1 border rounded hover:bg-red-50 text-red-600">Delete</button>
                              </div>
                            )}
                          </div>
                          {post.body && <p className="mt-2 text-sm whitespace-pre-wrap leading-relaxed break-words">Description: {post.body}</p>}
                        {post.media_path && (
                          <PostMedia src={resolveMediaUrl(post.media_path) || post.media_path} 
                              /* 👇 NEW: poster from API if present */
                             poster={post.media_poster ? (resolveImageUrl(post.media_poster, apiBase) || post.media_poster) : undefined}
                                            />
                        )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {products.length === 0 && !loading && !error && (
            <div className="text-sm text-neutral-500">You have no membership products.</div>
          )}
        </div>
      )}
      {tab === "others" && (
        <div className="space-y-6">
          {otherProducts.map(prod => {
            const postsForProd = postsByProd[prod.id] || [];
            const expanded = expandedProductId === prod.id;
            const isHighlighted = highlightProductId === prod.id;
            return (
              <div key={prod.id} className={`rounded-2xl overflow-hidden ${isHighlighted ? 'bg-green-50 border border-green-200 shadow-lg' : 'bg-white ring-1 ring-black/5'} transition-all duration-300`}>
                <div className={`flex items-center gap-3 px-4 py-3 ${isHighlighted ? 'bg-green-100/70' : 'bg-neutral-50/70'} border-b`}>
                  <button
                    aria-expanded={expanded}
                    onClick={() => setExpandedProductId(prev => prev === prod.id ? null : prod.id)}
                    className="cursor-pointer relative flex-1 min-w-0 text-left"
                  >
                    <h1 className="font-bold text-base md:text-lg leading-tight truncate">
                      Creator: {prod.display_name}
                    </h1>
                    <h2 className="font-bold text-base md:text-lg leading-tight truncate">
                       {prod.title || `Product #${prod.id}`}
                    </h2>
                    <p className="text-xs text-neutral-500">
                      Date: {prod.created_at && new Date(prod.created_at).toLocaleDateString()}
                    </p>

                    {/* Mobile: inline hint below content */}
                    <div className="mt-1 text-sm font-semibold text-neutral-700 sm:hidden">
                      {expanded ? "Tap to Close" : "Tap to Open"}
                    </div>

                    {/* sm+ : centered overlay hint */}
                    <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 hidden sm:block sm:text-base md:text-lg font-semibold text-neutral-700">
                      {expanded ? "Tap to Close" : "Tap to Open"}
                    </span>
                  </button>
                  <span className={`text-[10px] px-2 py-1 rounded-full ${isHighlighted ? 'bg-green-200 text-green-800' : 'bg-neutral-200 text-neutral-600'}`}>Subscribed</span>
                </div>
                {expanded && (
                  <div>
                    {postsForProd.length === 0 && (
                      <div className="p-5 text-sm text-neutral-500 flex items-center gap-3">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-400">∅</span>
                        <span>No posts yet from this creator.</span>
                      </div>
                    )}
                      {postsForProd.map(post => (
                       <div key={post.id} className="border-t hover:bg-neutral-50 transition">
                        {/* Row with avatar + text only */}
                        <div className="p-4 flex gap-3">
                          {/* Avatar */}
                          <img
                            src={resolveImageUrl(post.profile_image, apiBase) || post.profile_image}
                            alt="Profile"
                            className="h-full w-[50px] rounded-full object-cover"
                          />

                          {/* Content (no audio here) */}
                          <div className="flex-1 min-w-0">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-xs text-neutral-500 flex-wrap">
                                <span>{new Date(post.created_at).toLocaleString()}</span>
                              </div>
                              {post.title && (
                                <h3 className="font-bold text-base md:text-lg mt-1 leading-snug break-words">
                                  {post.title}
                                </h3>
                              )}
                              {post.body && (
                                <p className="mt-2 text-sm whitespace-pre-wrap leading-relaxed break-words">
                                  {post.body}
                                </p>
                              )}
                            </div>

                            {/* Keep images/videos inside the text column */}
                            {post.media_path && !isAudioMedia(null, post.media_path) && (
                              <PostMedia src={resolveMediaUrl(post.media_path) || post.media_path}
                              poster={post.media_poster ? (resolveImageUrl(post.media_poster, apiBase) || post.media_poster) : undefined} />
                            )}
                          </div>
                        </div>

                        {/* AUDIO ONLY: put it in its own row under the avatar, with a touch more space */}
                        {post.media_path && isAudioMedia(null, post.media_path) && (
                          <div className="px-4 pb-4"> {/* aligns with card padding; prevents overlap */}
                            <PostMedia
                              src={resolveMediaUrl(post.media_path) || post.media_path}
                              bleed
                            />
                          </div>
                        )}
                      </div>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
          {otherProducts.length === 0 && !loading && !error && (
            <div className="text-sm text-neutral-500">No memberships to other creators.</div>
          )}
        </div>
      )}

      {/* Add Modal */}
      {isCreator && addingProduct && (
        <div className="fixed inset-0 z-40 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closeAdd} />
          <div role="dialog" aria-modal="true" className="relative z-50 w-full max-w-md rounded-2xl bg-white shadow-xl border p-5 animate-in fade-in zoom-in max-h-[85vh] overflow-y-auto">
            <h2 className="text-sm font-semibold mb-3">New post for {addingProduct.title || `Product #${addingProduct.id}`}</h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-1">Title</label>
                <input value={draftTitle} onChange={e => setDraftTitle(e.target.value)} placeholder="Post title" className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-1">Body</label>
                <textarea value={draftBody} onChange={e => setDraftBody(e.target.value)} placeholder="Write something..." rows={5} className="w-full rounded-md border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-2">Media</label>
                {!draftMediaPreview && (
                  <label className="flex flex-col items-center justify-center gap-2 w-full h-36 border border-dashed rounded-xl cursor-pointer text-xs text-neutral-500 hover:bg-neutral-50 transition">
                    <input type="file" accept="image/*,video/*,audio/*,.mp3" className="hidden" onChange={onFileInputChange} />
                    <span className="text-neutral-400 text-2xl leading-none">＋</span>
                    <span>Select or drop file</span>
                  </label>
                )}
                {draftMediaPreview && (
                  <div className="relative group">
                    {isAudioMedia(draftFile, draftMediaPreview) ? (
              <audio src={resolveMediaUrl(draftMediaPreview) || draftMediaPreview} controls className="w-full rounded-xl border" />
                ) : isVideoMedia(draftFile, draftMediaPreview) ? (
                    <video src={resolveMediaUrl(draftMediaPreview) || draftMediaPreview} controls className="w-full rounded-xl border" />
                  ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={resolveMediaUrl(draftMediaPreview) || draftMediaPreview} alt="preview" className="w-full rounded-xl border object-cover" />
                    )}
                    <div className="absolute top-2 right-2 flex gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition">
                      <button onClick={resetDraftMedia} className="cursor-pointer px-2 py-1 text-[10px] rounded-md bg-black/60 text-white hover:bg-black/80">Remove</button>
                      <label className="px-2 py-1 text-[10px] rounded-md bg-white/80 backdrop-blur text-neutral-700 border cursor-pointer hover:bg-white">
                        <input type="file" accept="image/*,video/*,audio/*,.mp3" className="hidden" onChange={onFileInputChange} />
                        Replace
                      </label>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={closeAdd} className="cursor-pointer px-3 h-8 rounded-md text-xs border hover:bg-neutral-100">Cancel</button>
              <button onClick={saveAdd} className="cursor-pointer px-3 h-8 rounded-md text-xs bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50" disabled={addingSaving || (!draftTitle.trim() && !draftBody.trim() && !draftMediaPreview)}>{addingSaving ? 'Creating...' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {isCreator && editingPost && (
        <div className="fixed inset-0 z-40 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closeEdit} />
          <div role="dialog" aria-modal="true" className="relative z-50 w-full max-w-md rounded-2xl bg-white shadow-xl border p-5 animate-in fade-in zoom-in max-h-[85vh] overflow-y-auto">
            <h2 className="text-sm font-semibold mb-3">Edit Post</h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-1">Title</label>
                <input value={draftTitle} onChange={e => setDraftTitle(e.target.value)} placeholder="Post title" className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-1">Body</label>
                <textarea value={draftBody} onChange={e => setDraftBody(e.target.value)} placeholder="Write something..." rows={5} className="w-full rounded-md border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
                 <div>
                <label className="text-xs font-medium text-neutral-600 block mb-2">Media</label>
                {!draftMediaPreview && (
                  <label className="flex flex-col items-center justify-center gap-2 w-full h-36 border border-dashed rounded-xl cursor-pointer text-xs text-neutral-500 hover:bg-neutral-50 transition">
                    <input type="file" accept="image/*,video/*,audio/*,.mp3" className="hidden" onChange={onFileInputChange} />
                    <span className="text-neutral-400 text-2xl leading-none">＋</span>
                    <span>Select or drop file</span>
                  </label>
                )}
                {draftMediaPreview && (
                  <div className="relative group">
                  {isAudioMedia(draftFile, draftMediaPreview) ? (
                    <audio src={resolveMediaUrl(draftMediaPreview) || draftMediaPreview} controls className="w-full rounded-xl border" />
                  ) : isVideoMedia(draftFile, draftMediaPreview) ? (
                      <video src={resolveMediaUrl(draftMediaPreview) || draftMediaPreview} controls className="w-full rounded-xl border" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={resolveMediaUrl(draftMediaPreview) || draftMediaPreview}  alt="preview" className="w-full rounded-xl border object-cover" />
                    )}
                    <div className="absolute top-2 right-2 flex gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition">
                      <button onClick={resetDraftMedia} className="cursor-pointer px-2 py-1 text-[10px] rounded-md bg-black/60 text-white hover:bg-black/80">Remove</button>
                      <label className="px-2 py-1 text-[10px] rounded-md bg-white/80 backdrop-blur text-neutral-700 border cursor-pointer hover:bg-white">
                        <input type="file" accept="image/*,video/*,audio/*,.mp3" className="hidden" onChange={onFileInputChange} />
                        Replace
                      </label>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={closeEdit} className="px-3 h-8 rounded-md text-xs border hover:bg-neutral-100">Cancel</button>
              <button onClick={saveEdit} className="px-3 h-8 rounded-md text-xs bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50" disabled={!draftTitle.trim() && !draftBody.trim() && !draftMediaPreview}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {isCreator && deletingPost && (
        <div className="fixed inset-0 z-40 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closeDelete} />
          <div role="alertdialog" aria-modal="true" className="relative z-50 w-full max-w-sm rounded-xl bg-white shadow-xl border p-5 animate-in fade-in zoom-in">
            <h2 className="text-sm font-semibold mb-2">Delete Post</h2>
            <p className="text-xs text-neutral-600 mb-4">Are you sure you want to delete this post? This action cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={closeDelete} className="px-3 h-8 rounded-md text-xs border hover:bg-neutral-100">Cancel</button>
              <button onClick={confirmDelete} className="px-3 h-8 rounded-md text-xs bg-red-600 text-white hover:bg-red-500 disabled:opacity-50" disabled={deletingSaving}>{deletingSaving ? 'Deleting...' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}
    </main>
    </div>
  );
}