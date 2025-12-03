// src/app/dashboard/page.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { creatorProfilePath } from "@/lib/creatorSlug";
import { useAuth } from "@/components/auth/AuthProvider";
import { loadAuth } from "@/lib/auth";
import React from "react";

import { API_BASE } from "@/lib/api";
import { setFlash } from "@/lib/flash";

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

async function presignAndUploadToPrivateBucket(apiBase: string, file: File) {
  // 1) Ask backend for a presigned target
    const presignRes = await fetch(`${apiBase}/api/uploads/presign-request`, {
      method: "POST",
      credentials: "include",
      headers: buildAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
      }),
    });

  if (!presignRes.ok) {
    const text = await presignRes.text().catch(() => "");
    throw new Error(text || `Presign failed (${presignRes.status})`);
  }

  const presign: any = await presignRes.json();

  // 2) Handle common S3 styles: POST (fields) or PUT (no fields)
  if (presign?.fields && presign?.url) {
    // S3 POST form
    const form = new FormData();
    Object.entries(presign.fields).forEach(([k, v]) => form.append(k, String(v)));
    form.append("file", file);
    const up = await fetch(presign.url, { method: "POST", body: form });
    if (!up.ok) throw new Error(`Upload failed (POST) ${up.status}`);
    return { key: presign.key ?? presign.fields?.key ?? null, contentType: file.type || null };
  }

  if (presign?.url) {
    // PUT style
    const up = await fetch(presign.url, {
      method: presign.method || "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!up.ok) throw new Error(`Upload failed (PUT) ${up.status}`);
    return { key: presign.key ?? null, contentType: file.type || null };
  }

  throw new Error("Unknown presign response");
}

function resolveImageUrl(src: string | null | undefined, apiBase: string): string | null {
  if (!src) return null;
  let s = src.trim();
  if (s.startsWith("//")) s = s.slice(1);
  if (/^https?:\/\//i.test(s)) return s;
  if (!s.startsWith("/")) s = `/${s}`;
  return `${apiBase}${s}`;
}
function guessFromExtension(url: string): "image" | "video" | "audio" | "document" | "other" | null {
  const clean = url.split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(clean)) return "image";
  if (/\.(mp4|m4v|mov|webm|avi|mkv)$/.test(clean)) return "video";
  if (/\.(mp3|wav|m4a|aac|ogg|webm)$/.test(clean)) return "audio";
  if (/\.(pdf|csv|xlsx?|xls)$/.test(clean)) return "document";
  return null;
}

function typeFromContentType(ct: string | null): "image" | "video" | "audio" | "document" | "other" {
  if (!ct) return "other";
  const low = ct.toLowerCase();
  if (low.startsWith("image/")) return "image";
  if (low.startsWith("video/")) return "video";
  if (low.startsWith("audio/")) return "audio";
  if (low.includes("pdf") || low.includes("spreadsheet") || low.includes("ms-excel") || low.includes("csv"))
   return "document";
  return "other";
}

async function sniffContentType(url: string): Promise<"image"|"video"|"audio"|"other"> {
  try {
    // Try HEAD first (fast, no body)
    const head = await fetch(url, { method: "HEAD", credentials: "include", cache: "no-store" });
    const ct = head.headers.get("content-type");
    if (ct) return typeFromContentType(ct);
  } catch {/* ignore */}

  try {
    // Fallback: tiny ranged GET (many servers support this)
    const tiny = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      credentials: "include",
      cache: "no-store",
    });
    const ct = tiny.headers.get("content-type");
    if (ct) return typeFromContentType(ct);
  } catch {/* ignore */}

  return "other";
}
function xhrUpload({ url, method, headers, body, onProgress }: {
  url: string; method: string; headers?: Record<string,string>;
  body: Document | BodyInit | null; onProgress?: (sent:number,total:number)=>void;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    if (headers) for (const [k,v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onload  = () => resolve(new Response(xhr.response, { status: xhr.status, statusText: xhr.statusText }));

    // Note: do NOT set xhr.responseType for S3 POST/PUT
    xhr.send(body);
  });
}

/** Same signature as your existing presign; now accepts onProgress and uses XHR for the upload step. */
async function presignAndUploadToPrivateBucketWithProgress(
  apiBase: string,
  file: File,
  onProgress?: (sent:number,total:number)=>void
) {
  // 1) Presign
    const presignRes = await fetch(`${apiBase}/api/uploads/presign-request`, {
      method: "POST",
      credentials: "include",
      headers: buildAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || "application/octet-stream",
      }),
    });
  if (!presignRes.ok) throw new Error(await presignRes.text().catch(() => `Presign failed (${presignRes.status})`));
  const presign: any = await presignRes.json();

  // 2) Upload with progress (S3 POST form or PUT)
  if (presign?.fields && presign?.url) {
    const form = new FormData();
    Object.entries(presign.fields).forEach(([k, v]) => form.append(k, String(v)));
    form.append("file", file);

    const upRes = await xhrUpload({ url: presign.url, method: "POST", body: form, onProgress });
    if (!upRes.ok) throw new Error(`Upload failed (POST) ${upRes.status}`);
    return { key: presign.key ?? presign.fields?.key ?? null, contentType: file.type || null };
  }

  if (presign?.url) {
    const upRes = await xhrUpload({
      url: presign.url,
      method: presign.method || "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
      onProgress,
    });
    if (!upRes.ok) throw new Error(`Upload failed (PUT) ${upRes.status}`);
    return { key: presign.key ?? null, contentType: file.type || null };
  }

  throw new Error("Unknown presign response");
}

/** Legacy multipart to your API with progress via XHR */
async function uploadCompleteMultipartWithProgress(
  url: string,
  fd: FormData,
  headers: Record<string,string>,
  onProgress?: (sent:number,total:number)=>void
) {
  const res = await xhrUpload({ url, method: "POST", headers, body: fd, onProgress });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch {/* non-json */}
  if (!res.ok) throw new Error(extractMessage(json, `Upload failed (${res.status})`));
  return json;
}

function VideoWithPoster({ src, poster, className = "" }: { src: string; poster?: string; className?: string }) {
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
  const [clientGeneratedPoster, setClientGeneratedPoster] = useState<string | null>(null);
  const [pausedFramePoster, setPausedFramePoster] = useState<string | null>(null);
  const [posterLoading, setPosterLoading] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [resolvedVideoSrc, setResolvedVideoSrc] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [zoomOverlayVisible, setZoomOverlayVisible] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasPosterProp = Boolean(poster?.trim());

  // Resolve video source (let <video> follow redirects itself)
  React.useEffect(() => {
    setResolvedVideoSrc(null);
    setVideoError(null);

    if (!src) {
      console.log('[Dashboard VideoWithPoster] No video src provided');
      return;
    }

    // If blob/data URL, use directly; otherwise hand the URL straight to <video>
    if (src.startsWith('blob:') || src.startsWith('data:')) {
      setResolvedVideoSrc(src);
      return;
    }

    // IMPORTANT: do NOT prefetch protected endpoints; let <video> follow 302
    setResolvedVideoSrc(src);
  }, [src]);


  // Fetch poster if provided
  React.useEffect(() => {
    let revoke: string | null = null;
    setResolvedPoster(null);
    const url = (poster || "").trim();
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

  // Generate client-side poster from first frame
  const generateClientPoster = useCallback(() => {
    const v = videoRef.current;
    if (!v || !resolvedVideoSrc || v.readyState < 2 || v.videoWidth === 0) {
      console.log('[Dashboard VideoWithPoster] Cannot generate poster - video not ready', {
        video: !!v,
        resolvedSrc: !!resolvedVideoSrc,
        readyState: v?.readyState,
        dimensions: v ? `${v.videoWidth}x${v.videoHeight}` : 'N/A'
      });
      return;
    }
    
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      setClientGeneratedPoster(dataUrl);
      console.log('[Dashboard VideoWithPoster] ✓ Client poster generated');
    } catch (err) {
      console.error('[Dashboard VideoWithPoster] Error generating poster:', err);
    }
  }, [resolvedVideoSrc]);

  // Generate paused frame poster
  const generatePausedPoster = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.readyState < 2 || v.videoWidth === 0) return;
    
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      setPausedFramePoster(dataUrl);
      console.log('[Dashboard VideoWithPoster] ✓ Paused frame poster generated');
    } catch (err) {
      console.error('[Dashboard VideoWithPoster] Error generating paused poster:', err);
    }
  }, []);

  // Generate poster if no backend poster
  useEffect(() => {
    if (poster || !resolvedVideoSrc) return;
    const v = videoRef.current;
    if (!v) return;
    
    console.log('[Dashboard VideoWithPoster] Setting up client poster generation for:', resolvedVideoSrc);
    
    const handleCanPlay = () => {
      console.log('[Dashboard VideoWithPoster] Video can play, attempting poster generation');
      if (v.readyState >= 3 && v.videoWidth > 0 && v.videoHeight > 0) {
        setTimeout(() => {
          generateClientPoster();
        }, 200);
      }
    };

    const handleLoadedData = () => {
      console.log('[Dashboard VideoWithPoster] Video data loaded, readyState:', v.readyState);
      if (v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) {
        setTimeout(() => {
          generateClientPoster();
        }, 100);
      }
    };
    
    v.addEventListener('loadeddata', handleLoadedData);
    v.addEventListener('canplay', handleCanPlay);
    
    // Try immediately if already loaded
    if (v.readyState >= 2) {
      setTimeout(() => handleLoadedData(), 50);
    }
    
    return () => {
      v.removeEventListener('loadeddata', handleLoadedData);
      v.removeEventListener('canplay', handleCanPlay);
    };
  }, [poster, resolvedVideoSrc, generateClientPoster]);

  // Determine effective poster
  const effectivePoster = React.useMemo(() => {
    if (pausedFramePoster && !isPlaying) return pausedFramePoster;
    if (resolvedPoster) return resolvedPoster;
    if (clientGeneratedPoster) return clientGeneratedPoster;
    return undefined;
  }, [resolvedPoster, clientGeneratedPoster, pausedFramePoster, isPlaying]);

  // Update poster visibility
  useEffect(() => {
    if (effectivePoster && !isPlaying) {
      setShowPosterOverlay(true);
    } else if (isPlaying) {
      setShowPosterOverlay(false);
    }
  }, [effectivePoster, isPlaying]);

  // Setup video element
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.setAttribute("playsinline", "true");
      v.setAttribute("webkit-playsinline", "true");
      v.setAttribute("x5-playsinline", "true");
      v.pause();
      
      // Try to seek to a small time to show first frame
      const handleCanPlayThrough = () => {
        if (v.currentTime === 0 && v.duration > 0) {
          v.currentTime = 0.01; // Very small seek to ensure first frame shows
        }
      };
      
      v.addEventListener('canplaythrough', handleCanPlayThrough, { once: true });
      
      setIsPlaying(false);
      setShowPosterOverlay(true);
      
      return () => {
        v.removeEventListener('canplaythrough', handleCanPlayThrough);
      };
    } catch {}
  }, []);

  const formatTime = useCallback((t: number) => {
    if (!isFinite(t) || t < 0) t = 0;
    const total = Math.floor(t);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }, []);

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

  const getFracFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el || !duration) return 0;
    const rect = el.getBoundingClientRect();
    const frac = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, frac));
  }, [duration]);

  const seekToFraction = useCallback((frac: number) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    const newTime = frac * duration;
    v.currentTime = newTime;
    setCurrentTime(newTime);
  }, [duration]);

  const handleScrubStart = useCallback((clientX: number) => {
    setSeeking(true);
    const frac = getFracFromClientX(clientX);
    seekToFraction(frac);
  }, [getFracFromClientX, seekToFraction]);

  const handleScrubMove = useCallback((clientX: number) => {
    if (!seeking) return;
    const frac = getFracFromClientX(clientX);
    seekToFraction(frac);
  }, [seeking, getFracFromClientX, seekToFraction]);

  const handleScrubEnd = useCallback(() => {
    setSeeking(false);
  }, []);

  const scheduleOverlayAutoHide = useCallback((delay = 2500) => {
    clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = window.setTimeout(() => {
      setOverlayVisible(false);
    }, delay);
  }, []);

  const clearOverlayTimer = useCallback(() => {
    clearTimeout(overlayTimerRef.current);
  }, []);

  const toggleVideoPlayback = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) {
      // Hide poster overlay immediately when initiating play
      setShowPosterOverlay(false);
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, []);

  const handleZoomIn = useCallback(() => {
    setZoomLevel((prev) => Math.min(prev + 0.25, 3)); // Max zoom 3x
    setZoomOverlayVisible(true);
    setTimeout(() => setZoomOverlayVisible(false), 1500);
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomLevel((prev) => Math.max(prev - 0.25, 0.5)); // Min zoom 0.5x
    setZoomOverlayVisible(true);
    setTimeout(() => setZoomOverlayVisible(false), 1500);
  }, []);

  const resetZoom = useCallback(() => {
    setZoomLevel(1);
    setZoomOverlayVisible(true);
    setTimeout(() => setZoomOverlayVisible(false), 1500);
  }, []);

  const handleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Detect specific devices for better handling
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    console.log('[VideoWithPoster] Dashboard fullscreen toggle - isIOS:', isIOS, 'isMobile:', isMobile, 'current state:', isFullscreen);

    // For iPhone/iOS, always use CSS-only approach since Fullscreen API is unreliable
    if (isIOS) {
      console.log('[VideoWithPoster] iOS detected - using CSS-only fullscreen toggle');
      setIsFullscreen(!isFullscreen);
      return;
    }

    // Check if we're currently in fullscreen (document API)
    const isDocumentFullscreen = !!(
      document.fullscreenElement ||
      (document as any).webkitFullscreenElement ||
      (document as any).mozFullScreenElement ||
      (document as any).msFullscreenElement
    );

    if (!isFullscreen) {
      // Entering fullscreen - use CSS fallback directly for mobile
      if (isMobile || !container.requestFullscreen) {
        console.log('[VideoWithPoster] Using CSS fallback for mobile/unsupported browser');
        setIsFullscreen(true);
        return;
      }

      // Try native fullscreen API for desktop
      const requestFullscreen = 
        container.requestFullscreen ||
        (container as any).webkitRequestFullscreen ||
        (container as any).webkitRequestFullScreen ||
        (container as any).mozRequestFullScreen ||
        (container as any).msRequestFullscreen;

      if (requestFullscreen) {
        requestFullscreen.call(container).then(() => {
          setIsFullscreen(true);
        }).catch((err: any) => {
          console.log('Native fullscreen failed, using CSS fallback:', err.message);
          setIsFullscreen(true);
        });
      } else {
        setIsFullscreen(true);
      }
    } else {
      // Exiting fullscreen - for mobile, always use direct state toggle
      if (isMobile || !isDocumentFullscreen) {
        console.log('[VideoWithPoster] Mobile/CSS fullscreen exit');
        setIsFullscreen(false);
        return;
      }

      // Try native fullscreen exit for desktop
      const exitFullscreen = 
        document.exitFullscreen ||
        (document as any).webkitExitFullscreen ||
        (document as any).webkitCancelFullScreen ||
        (document as any).mozCancelFullScreen ||
        (document as any).msExitFullscreen;

      if (exitFullscreen) {
        exitFullscreen.call(document).then(() => {
          setIsFullscreen(false);
        }).catch((err: any) => {
          console.log('Native exit failed, forcing state change:', err.message);
          setIsFullscreen(false);
        });
      } else {
        setIsFullscreen(false);
      }
    }
  }, [isFullscreen]);

  // Listen for fullscreen changes - handle all browser prefixes
  React.useEffect(() => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    const handleFullscreenChange = () => {
      // iOS devices don't reliably support fullscreen events, skip entirely
      if (isIOS) {
        console.log('[VideoWithPoster] iOS detected - ignoring native fullscreen events');
        return;
      }

      const isFullscreenNow = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      );
      
      console.log('[VideoWithPoster] Dashboard fullscreen change detected:', isFullscreenNow);
      
      // On mobile, primarily rely on CSS state, but update if native fullscreen changes
      if (!isMobile || isFullscreenNow) {
        setIsFullscreen(isFullscreenNow);
      }
    };

    // Add listeners for all browser prefixes
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);

  // Add ESC key listener for exiting fullscreen
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        console.log('[VideoWithPoster] Dashboard ESC key pressed - exiting fullscreen');
        setIsFullscreen(false);
      }
    };

    if (isFullscreen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFullscreen]);

  const togglePlayback = () => {
    const v = videoRef.current;
    console.log('[VideoWithPoster] togglePlayback called, video:', v, 'paused:', v?.paused);
    if (!v) return;
    if (v.paused || v.ended) {
      console.log('[VideoWithPoster] Starting playback');
      setShowPosterOverlay(false);
      setIsPlaying(true);
      v.play().catch((err: any) => {
        console.error('[VideoWithPoster] Play failed:', err);
      });
    } else {
      console.log('[VideoWithPoster] Pausing playback');
      v.pause();
    }
  };

  // Show error state if video resolution failed
  if (videoError) {
    return (
      <div className={`relative ${className} bg-red-50 border-2 border-red-200 rounded-lg`}>
        <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center">
          <div className="text-red-600 text-sm font-medium mb-2">Video Error</div>
          <div className="text-red-500 text-xs">{videoError}</div>
          <div className="text-gray-400 text-xs mt-2">Source: {src}</div>
        </div>
      </div>
    );
  }

  // Show loading state while resolving video
  if (!resolvedVideoSrc) {
    return (
      <div className={`relative ${className} bg-gray-100 animate-pulse rounded-lg`}>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-gray-500 text-sm">Loading video...</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      <div 
        ref={containerRef}
        className={`w-full rounded-xl overflow-hidden ring-1 ring-neutral-200 ${isFullscreen ? 'fixed inset-0 z-[9999] bg-black flex items-center justify-center rounded-none ring-0' : ''}`}
        style={isFullscreen ? {
          width: '100vw',
          height: '100vh',
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 9999,
        } : undefined}
      >
        {/* Mobile Fullscreen Exit Helper - tap anywhere to exit */}
        {isFullscreen && (
          <div 
            className="absolute inset-0 z-[1] bg-transparent cursor-pointer md:hidden"
            onClick={(e) => {
              // Only handle background clicks, not clicks on video or controls
              if (e.target === e.currentTarget) {
                console.log('[VideoWithPoster] Dashboard mobile background tap detected - exiting fullscreen');
                setIsFullscreen(false);
              }
            }}
            onTouchEnd={(e) => {
              // iOS-specific touch handler for better reliability
              if (e.target === e.currentTarget) {
                e.preventDefault();
                e.stopPropagation();
                console.log('[VideoWithPoster] Dashboard iOS background touch detected - exiting fullscreen');
                setIsFullscreen(false);
              }
            }}
          />
        )}

        {/* Mobile Fullscreen Exit Instructions */}
        {isFullscreen && (
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-[10] md:hidden pointer-events-none">
            <div className="bg-black/70 text-white text-sm px-4 py-2 rounded-full backdrop-blur-sm">
              Tap outside video to exit fullscreen
            </div>
          </div>
        )}

        {/* iOS-Specific Large Exit Button */}
        {isFullscreen && /iPad|iPhone|iPod/.test(navigator.userAgent) && (
          <button
            className="absolute top-4 right-4 z-[15] w-12 h-12 bg-black/80 text-white rounded-full flex items-center justify-center backdrop-blur-sm border-2 border-white/30 md:hidden touch-manipulation"
            onClick={(e) => {
              e.stopPropagation();
              console.log('[VideoWithPoster] Dashboard iOS large exit button clicked');
              setIsFullscreen(false);
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              e.stopPropagation();
              console.log('[VideoWithPoster] Dashboard iOS large exit button touched');
              setIsFullscreen(false);
            }}
            aria-label="Exit fullscreen"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M18 6L6 18M6 6l12 12"></path>
            </svg>
          </button>
        )}
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
            src={resolvedVideoSrc}
            playsInline
            preload="metadata"
            crossOrigin="use-credentials"
            poster={effectivePoster || poster}
            onLoadedMetadata={() => {
              const v = videoRef.current;
              const d = v?.duration || 0;
              setDuration(isFinite(d) ? d : 0);
              updateBuffered();
              setVideoReady(true);
              console.log('[Dashboard VideoWithPoster] Video metadata loaded, duration:', d, 'readyState:', v?.readyState, 'hasEffectivePoster:', Boolean(effectivePoster));
              
              // Try to seek to first frame to ensure it's visible
              if (v && !effectivePoster && v.readyState >= 1) {
                v.currentTime = 0.1;
              }
              
              // Ensure poster is shown when video is ready but not playing
              if (!isPlaying && effectivePoster) {
                setShowPosterOverlay(true);
              }
            }}
            onLoadedData={() => {
              // Video data is loaded, ensure poster shows if not playing
              const v = videoRef.current;
              console.log('[Dashboard VideoWithPoster] Video data loaded, readyState:', v?.readyState);
              setVideoReady(true);
              
              // Generate client poster if no backend poster and video is ready
              if (!hasPosterProp && v && v.readyState >= 2 && v.videoWidth > 0) {
                console.log('[Dashboard VideoWithPoster] Attempting to generate first frame poster');
                setTimeout(() => generateClientPoster(), 100);
              }
              
              if (!isPlaying && effectivePoster) {
                setShowPosterOverlay(true);
              }
            }}
            onTimeUpdate={() => {
              const v = videoRef.current;
              if (!v) return;
              if (!seeking) setCurrentTime(v.currentTime || 0);
            }}
            onProgress={updateBuffered}
            onError={(e) => {
              console.error('[Dashboard VideoWithPoster] Video error:', e);
              const v = videoRef.current;
              if (v) {
                console.error('[Dashboard VideoWithPoster] Video src:', v.currentSrc);
                console.error('[Dashboard VideoWithPoster] Video poster:', v.poster);
                console.error('[Dashboard VideoWithPoster] Video error code:', v.error?.code, v.error?.message);
              }
            }}
            onPlay={() => {
              setIsPlaying(true);
              setShowPosterOverlay(false);
              setOverlayVisible(false);
              // Clear paused frame poster when playing
              setPausedFramePoster((prev) => {
                if (prev) URL.revokeObjectURL(prev);
                return null;
              });
              scheduleOverlayAutoHide(1200);
            }}
            onPause={() => {
              console.log('[Dashboard VideoWithPoster] Video paused');
              setIsPlaying(false);
              clearOverlayTimer();
              setOverlayVisible(true);
              const v = videoRef.current;
              
              // Always generate and show poster when paused
              if (v && v.currentTime > 0.01) {
                // Generate immediately without delay to avoid black flash
                generatePausedPoster();
                // Force show overlay immediately
                setShowPosterOverlay(true);
              } else {
                // At the beginning, show existing poster or generate one
                if (effectivePoster) {
                  setShowPosterOverlay(true);
                } else if (v) {
                  // Generate even at start if no poster exists
                  generatePausedPoster();
                  setShowPosterOverlay(true);
                }
              }
            }}
            onEnded={() => {
              setIsPlaying(false);
              clearOverlayTimer();
              setOverlayVisible(true);
              setShowPosterOverlay(Boolean(effectivePoster));
              setCurrentTime(0);
            }}
            className={`w-full bg-black object-contain ${
              isFullscreen 
                ? 'h-full max-h-screen max-w-full' 
                : 'h-auto max-h-[50vh] sm:max-h-[60vh] md:max-h-[65vh] lg:max-h-[70vh]'
            }`}
            style={{ 
              transform: `scale(${zoomLevel})`,
              transformOrigin: 'center center',
              transition: 'transform 0.2s ease-in-out'
            }}
          />
          
          {/* Poster image overlay - shown when video is not playing and we have a poster */}
          {!isPlaying && effectivePoster && (
            <div 
              className="absolute inset-0 z-[5] pointer-events-none select-none"
              style={{ backgroundColor: '#000' }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={effectivePoster}
                src={effectivePoster}
                alt="video preview"
                className={`w-full h-full object-contain ${
                  isFullscreen 
                    ? 'max-h-screen max-w-full' 
                    : 'max-h-[50vh] sm:max-h-[60vh] md:max-h-[65vh] lg:max-h-[70vh]'
                }`}
                style={{ 
                  display: 'block',
                  transform: `scale(${zoomLevel})`,
                  transformOrigin: 'center center',
                  transition: 'transform 0.2s ease-in-out'
                }}
                onLoad={() => {
                  console.log('[Dashboard VideoWithPoster] ✓ Poster overlay image loaded and visible:', effectivePoster.substring(0, 50));
                }}
                onError={(e) => {
                  console.error('[Dashboard VideoWithPoster] ✗ Poster overlay image failed to load:', effectivePoster.substring(0, 50));
                }}
              />
            </div>
          )}
          
          {/* Fallback: show video's native poster if no overlay poster yet */}
          {!isPlaying && !effectivePoster && posterLoading && (
            <div className="absolute inset-0 z-[4] flex items-center justify-center bg-neutral-900 pointer-events-none">
              <div className="text-white text-sm opacity-70">Loading preview...</div>
            </div>
          )}
          
          {/* Additional fallback: when no poster at all, ensure video first frame is visible */}
          {!isPlaying && !effectivePoster && !posterLoading && videoReady && (
            <div className="absolute inset-0 z-[3] bg-transparent pointer-events-none" />
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

          {/* Zoom Controls */}
          <div className="absolute top-3 right-3 z-10">
            <div
              className={`flex flex-col gap-1 transition-opacity ${
                overlayVisible || !isPlaying ? "opacity-100" : "opacity-0"
              }`}
            >
              {/* Zoom In */}
              <button
                type="button"
                aria-label="Zoom in"
                onClick={(e) => {
                  e.stopPropagation();
                  handleZoomIn();
                }}
                disabled={zoomLevel >= 3}
                className="w-8 h-8 rounded-md bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 hover:bg-black/75 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="M21 21l-4.35-4.35"></path>
                  <line x1="9" y1="11" x2="13" y2="11"></line>
                  <line x1="11" y1="9" x2="11" y2="13"></line>
                </svg>
              </button>

              {/* Zoom Out */}
              <button
                type="button"
                aria-label="Zoom out"
                onClick={(e) => {
                  e.stopPropagation();
                  handleZoomOut();
                }}
                disabled={zoomLevel <= 0.5}
                className="w-8 h-8 rounded-md bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 hover:bg-black/75 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="M21 21l-4.35-4.35"></path>
                  <line x1="9" y1="11" x2="13" y2="11"></line>
                </svg>
              </button>

              {/* Reset Zoom */}
              {zoomLevel !== 1 && (
                <button
                  type="button"
                  aria-label="Reset zoom"
                  onClick={(e) => {
                    e.stopPropagation();
                    resetZoom();
                  }}
                  className="w-8 h-8 rounded-md bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 hover:bg-black/75 flex items-center justify-center text-xs font-bold"
                >
                  1x
                </button>
              )}

              {/* Fullscreen */}
              <button
                type="button"
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                onClick={(e) => {
                  e.stopPropagation();
                  // iOS-specific direct toggle for better reliability
                  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
                  if (isIOS) {
                    console.log('[VideoWithPoster] Dashboard iOS fullscreen button - direct toggle');
                    setIsFullscreen(!isFullscreen);
                  } else {
                    handleFullscreen();
                  }
                }}
                onTouchStart={(e) => {
                  e.stopPropagation();
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  // iOS-specific touch handler
                  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
                  if (isIOS) {
                    console.log('[VideoWithPoster] Dashboard iOS touch end - direct toggle');
                    setIsFullscreen(!isFullscreen);
                  } else {
                    handleFullscreen();
                  }
                }}
                className={`${isFullscreen ? 'w-12 h-12' : 'w-8 h-8'} rounded-md bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 hover:bg-black/75 active:bg-black/80 flex items-center justify-center touch-manipulation transition-all duration-200`}
              >
                {isFullscreen ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Zoom Level Indicator */}
          {zoomOverlayVisible && (
            <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none">
              <div className="bg-black/75 text-white px-3 py-1 rounded-md text-sm font-medium backdrop-blur-sm">
                {zoomLevel === 1 ? '100%' : `${Math.round(zoomLevel * 100)}%`}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AttachmentViewer({
  src,
  className = "w-full rounded-lg border overflow-hidden bg-black/5", posterUrl,
}: { src: string; className?: string ; posterUrl?: string}) {
  const [kind, setKind] = React.useState<"image" | "video" | "audio" | "document" | "other" | null>(guessFromExtension(src));
  const [errored, setErrored] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setErrored(false);

    (async () => {
      if (!kind) {
        const k = await sniffContentType(src);
        if (!cancelled) setKind(k);
      } else {
        setKind(kind);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (errored) {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
        Open attachment
      </a>
    );
  }

  if (kind === "image") {
    return <img src={src} alt="attachment" className={`${className} object-contain`} onError={() => setErrored(true)} />;
  }
  if (kind === "video") return <VideoWithPoster src={src} poster={posterUrl} className={className} />;
  if (kind === "audio") {
    return (
      <audio
        src={src}
        controls
        preload="metadata"
        className={`${className} w-full`}
        onError={() => setErrored(true)}
      />
    );
  }

   if (kind === "document") {
   const lower = src.toLowerCase();
   const isPdf = lower.endsWith(".pdf");
   // Try inline preview for PDFs; otherwise show a simple card with a download link
   return isPdf ? (
     <iframe
       src={src}
       className={`${className} bg-white`}
       style={{ height: 480 }}
       title="Document preview"
       onError={() => setErrored(true)}
     />
   ) : (
     <div className={`${className} p-4 bg-white flex items-center justify-between`}>
       <div className="text-sm text-neutral-800 truncate">Document: {src.split("/").pop()}</div>
       <a
         href={src}
         target="_blank"
         rel="noopener noreferrer"
         className="rounded-md px-3 py-1 text-xs font-medium bg-neutral-900 text-white"
       >
         Download
       </a>
     </div>
   );
 }

  // Unknown: optimistically try video; fallback becomes link via onError.
  return <VideoWithPoster src={src} poster={posterUrl} className={className} />;
}

function LocalAttachmentPreview({ file, url }: { file: File | null; url: string | null }) {
  if (!file || !url) return null;

  const mime = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();

  const isVideo = mime.startsWith("video/") || /\.(mp4|webm|ogg|m4v|mov)$/.test(name);
  const isAudio = mime.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|webm)$/.test(name);
  const isImage = mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg)$/.test(name);
  const isPdf = mime === "application/pdf" || name.endsWith(".pdf");
  const isSpreadsheet = /(?:application\/vnd\.ms-excel|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)/.test(mime) || /\.(xlsx?|csv)$/.test(name);

  if (isAudio) {
    return <audio src={url} controls preload="metadata" className="block w-full bg-black" />;
  }
  if (isVideo) {
    return <VideoWithPoster src={url} className="" />;
  }
  if (isImage) {
    return <img src={url} alt="preview" className="block w-full h-auto object-contain bg-black" />;
  }
  if (isPdf) {
   return <iframe src={url} className="block w-full bg-white" style={{ height: 320 }} />;
 }
 if (isSpreadsheet) {
   return (
     <div className="p-3 rounded border bg-white text-sm text-neutral-800">
       {file.name} selected. Preview not supported — it’ll be sent as an attachment.
     </div>
   );
 }
  return <div className="text-sm text-neutral-700">{file.name}</div>;
}

// Video preview component with thumbnail support for dashboard uploads
function VideoPreviewWithThumbnail({ url }: { url: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [pausedThumbnail, setPausedThumbnail] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [zoomOverlayVisible, setZoomOverlayVisible] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  
  // Generate thumbnail from video frame
  const generateThumbnail = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return;
    
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      setThumbnail(dataUrl);
    } catch (err) {
      console.error('[VideoPreview] Error generating thumbnail:', err);
    }
  }, []);
  
  // Generate paused frame thumbnail
  const generatePausedThumbnail = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return;
    
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      setPausedThumbnail(dataUrl);
    } catch (err) {
      console.error('[VideoPreview] Error generating paused thumbnail:', err);
    }
  }, []);
  
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    
    const handleLoadedData = () => {
      setTimeout(() => generateThumbnail(), 100);
    };
    
    video.addEventListener('loadeddata', handleLoadedData);
    if (video.readyState >= 2) handleLoadedData();
    
    return () => video.removeEventListener('loadeddata', handleLoadedData);
  }, [generateThumbnail]);
  
  const handleZoomIn = useCallback(() => {
    setZoomLevel((prev) => Math.min(prev + 0.25, 3)); // Max zoom 3x
    setZoomOverlayVisible(true);
    setTimeout(() => setZoomOverlayVisible(false), 1500);
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomLevel((prev) => Math.max(prev - 0.25, 0.5)); // Min zoom 0.5x
    setZoomOverlayVisible(true);
    setTimeout(() => setZoomOverlayVisible(false), 1500);
  }, []);

  const resetZoom = useCallback(() => {
    setZoomLevel(1);
    setZoomOverlayVisible(true);
    setTimeout(() => setZoomOverlayVisible(false), 1500);
  }, []);

  const handleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Check if we're currently in fullscreen
    const isCurrentlyFullscreen = !!(
      document.fullscreenElement ||
      (document as any).webkitFullscreenElement ||
      (document as any).mozFullScreenElement ||
      (document as any).msFullscreenElement
    );

    if (!isCurrentlyFullscreen) {
      // Enter fullscreen - try different methods for cross-browser support
      const requestFullscreen = 
        container.requestFullscreen ||
        (container as any).webkitRequestFullscreen ||
        (container as any).webkitRequestFullScreen ||
        (container as any).mozRequestFullScreen ||
        (container as any).msRequestFullscreen;

      if (requestFullscreen) {
        requestFullscreen.call(container).then(() => {
          setIsFullscreen(true);
        }).catch((err: any) => {
          console.error('Error attempting to enable fullscreen:', err);
          // Fallback for mobile: simulate fullscreen with CSS
          setIsFullscreen(true);
        });
      } else {
        // Fallback for browsers that don't support fullscreen API (like iOS Safari)
        console.log('Fullscreen API not supported, using CSS fallback');
        setIsFullscreen(true);
      }
    } else {
      // Exit fullscreen
      const exitFullscreen = 
        document.exitFullscreen ||
        (document as any).webkitExitFullscreen ||
        (document as any).webkitCancelFullScreen ||
        (document as any).mozCancelFullScreen ||
        (document as any).msExitFullscreen;

      if (exitFullscreen) {
        exitFullscreen.call(document).then(() => {
          setIsFullscreen(false);
        }).catch((err: any) => {
          console.error('Error attempting to exit fullscreen:', err);
          setIsFullscreen(false);
        });
      } else {
        setIsFullscreen(false);
      }
    }
  }, []);

  // Listen for fullscreen changes - handle all browser prefixes
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFullscreenNow = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      );
      setIsFullscreen(isFullscreenNow);
    };

    // Add listeners for all browser prefixes
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);
  
  const effectiveThumbnail = pausedThumbnail || thumbnail;
  
  // Show error state if video failed
  if (videoError) {
    return (
      <div className="relative bg-red-50 border-2 border-red-200 rounded-lg p-4">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="text-red-600 text-sm font-medium mb-2">Video Error</div>
          <div className="text-red-500 text-xs">{videoError}</div>
          <div className="text-gray-400 text-xs mt-2">Source: {url}</div>
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className={`relative ${isFullscreen ? 'fixed inset-0 z-[9999] bg-black flex items-center justify-center' : ''}`}
      style={isFullscreen ? {
        width: '100vw',
        height: '100vh',
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 9999,
      } : undefined}
    >
      <video
        ref={videoRef}
        src={url}
        controls
        playsInline
        preload="metadata"
        crossOrigin="use-credentials"
        controlsList="nodownload noplaybackrate nofullscreen"  // ⬅️ add this
        poster={effectiveThumbnail || undefined}
        className={`block w-full object-contain bg-black ${
          isFullscreen 
            ? 'h-full max-h-screen max-w-full' 
            : 'h-auto max-h-[50vh] sm:max-h-[60vh] md:max-h-[65vh] lg:max-h-[70vh]'
        }`}
        style={{ 
          transform: `scale(${zoomLevel})`,
          transformOrigin: 'center center',
          transition: 'transform 0.2s ease-in-out'
        }}
        onLoadedMetadata={() => {
          console.log('[VideoPreviewWithThumbnail] Video metadata loaded');
          setVideoError(null);
        }}
        onLoadedData={() => {
          console.log('[VideoPreviewWithThumbnail] Video data loaded');
          setVideoError(null);
        }}
        onError={(e) => {
          console.error('[VideoPreviewWithThumbnail] Video element error:', e);
          const v = videoRef.current;
          if (v && v.error) {
            const errorCode = v.error.code;
            const errorMessage = v.error.message || `Media Error ${errorCode}`;
            console.error('[VideoPreviewWithThumbnail] Video error details:', { code: errorCode, message: errorMessage });
            setVideoError(errorMessage);
          } else {
            setVideoError('Video playback failed');
          }
        }}
        onPlay={() => {
          setIsPlaying(true);
          setPausedThumbnail(null);
        }}
        onPause={() => {
          setIsPlaying(false);
          const v = videoRef.current;
          if (v && v.currentTime > 0.01) {
            generatePausedThumbnail();
          }
        }}
        onEnded={() => {
          setIsPlaying(false);
          setPausedThumbnail(null);
        }}
      />
      {/* Thumbnail overlay when not playing */}
      {!isPlaying && effectiveThumbnail && (
        <div className="absolute inset-0 z-[5] pointer-events-none bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img 
            src={effectiveThumbnail} 
            alt="video thumbnail" 
            className={`w-full h-full object-contain ${
              isFullscreen 
                ? 'max-h-screen max-w-full' 
                : 'max-h-[45vh] sm:max-h-[50vh] md:max-h-[55vh] lg:max-h-[60vh]'
            }`}
            style={{ 
              transform: `scale(${zoomLevel})`,
              transformOrigin: 'center center',
              transition: 'transform 0.2s ease-in-out'
            }}
          />
        </div>
      )}
      {/* Play button */}
      {!isPlaying && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[VideoPreviewWithThumbnail] Play button clicked');
            const v = videoRef.current;
            if (v) {
              setIsPlaying(true);
              v.play().catch((err) => console.error('[VideoPreviewWithThumbnail] Play failed:', err));
            }
          }}
          onTouchStart={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[VideoPreviewWithThumbnail] Play button touched');
            const v = videoRef.current;
            if (v) {
              setIsPlaying(true);
              v.play().catch((err) => console.error('[VideoPreviewWithThumbnail] Play failed:', err));
            }
          }}
          className="cursor-pointer absolute z-[10] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 inline-flex h-14 w-14 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 hover:bg-black/75 active:bg-black/80"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7-11-7z"></path>
          </svg>
        </button>
      )}
      
      {/* Zoom Controls */}
      <div className="absolute top-3 right-3 z-10">
        <div className="flex flex-col gap-1">
          {/* Zoom In */}
          <button
            type="button"
            aria-label="Zoom in"
            onClick={(e) => {
              e.stopPropagation();
              handleZoomIn();
            }}
            disabled={zoomLevel >= 3}
            className="w-8 h-8 rounded-md bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 hover:bg-black/75 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="M21 21l-4.35-4.35"></path>
              <line x1="9" y1="11" x2="13" y2="11"></line>
              <line x1="11" y1="9" x2="11" y2="13"></line>
            </svg>
          </button>

          {/* Zoom Out */}
          <button
            type="button"
            aria-label="Zoom out"
            onClick={(e) => {
              e.stopPropagation();
              handleZoomOut();
            }}
            disabled={zoomLevel <= 0.5}
            className="w-8 h-8 rounded-md bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 hover:bg-black/75 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="M21 21l-4.35-4.35"></path>
              <line x1="9" y1="11" x2="13" y2="11"></line>
            </svg>
          </button>

          {/* Reset Zoom */}
          {zoomLevel !== 1 && (
            <button
              type="button"
              aria-label="Reset zoom"
              onClick={(e) => {
                e.stopPropagation();
                resetZoom();
              }}
              className="w-8 h-8 rounded-md bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 hover:bg-black/75 flex items-center justify-center text-xs font-bold"
            >
              1x
            </button>
          )}

          {/* Fullscreen */}
          <button
            type="button"
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            onClick={(e) => {
              e.stopPropagation();
              handleFullscreen();
            }}
            className="w-8 h-8 rounded-md bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 hover:bg-black/75 flex items-center justify-center"
          >
            {isFullscreen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Zoom Level Indicator */}
      {zoomOverlayVisible && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none">
          <div className="bg-black/75 text-white px-3 py-1 rounded-md text-sm font-medium backdrop-blur-sm">
            {zoomLevel === 1 ? '100%' : `${Math.round(zoomLevel * 100)}%`}
          </div>
        </div>
      )}
    </div>
  );
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

  const [decisionDialog, setDecisionDialog] = useState<{
  open: boolean;
  requestId: number | null;
  action: "accept" | "decline" | null;
}>({
  open: false,
  requestId: null,
  action: null,
});

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

  // Track which request is being accepted or declined
  const [decidingRequestId, setDecidingRequestId] = useState<number | null>(null);

  // Average rating (force fresh)
  const [averageRating, setAverageRating] = useState<number | null>(null);

  // Request modals
  const [activeRequest, setActiveRequest] = useState<any | null>(null);
  function openRequest(req: any) { setActiveRequest(req); }
  function closeRequest() { setActiveRequest(null); }

async function handleRequestDecision(
  requestId: number,
  action: "accept" | "decline"
) {
  if (!requestId || !action) return;

  // We already showed the nice dialog, so no window.confirm here
  setDecidingRequestId(requestId);

  try {
    const res = await fetch(
      `${apiBase}/api/requests/${encodeURIComponent(String(requestId))}/decision`,
      {
        method: "PATCH",
        credentials: "include",
        headers: buildAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ action }),
      }
    );

    const payload: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg =
        (payload && (payload.error || payload.message)) ||
        "Failed to update request";
      throw new Error(msg);
    }

    // Remove the request from the pending list after success
    setPendingRequests((prev) =>
      prev.filter((req) => Number(req.id) !== Number(requestId))
    );

    showToast(
      action === "decline"
        ? "Request rejected and the buyer has been refunded (minus Stripe fees)."
        : "Request updated."
    );
  } catch (err) {
    console.error("handleRequestDecision error:", err);
    showToast(
      err instanceof Error
        ? err.message
        : "Something went wrong while updating the request."
    );
  } finally {
    setDecidingRequestId(null);
    setDecisionDialog({ open: false, requestId: null, action: null });
  }
}

  // Complete modal
  const [activeCompleteRequest, setActiveCompleteRequest] = useState<any | null>(null);
  const completeFilesRef = useRef<HTMLInputElement | null>(null);
  const [completeDesc, setCompleteDesc] = useState<string>("");
  const [completing, setCompleting] = useState(false);
  const [completeFileNames, setCompleteFileNames] = useState<string[]>([]);
  const [completePreviewUrl, setCompletePreviewUrl] = useState<string | null>(null);
const [completePreviewFile, setCompletePreviewFile] = useState<File | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadPhase, setUploadPhase] = useState<null | "presigning" | "uploading" | "finalizing">(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

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
  setUploadPct(null);
  setUploadPhase(null);
  setUploadError(null);
  if (completeFilesRef.current) completeFilesRef.current.value = "";

  // also clear/revoke the preview
  if (completePreviewUrl?.startsWith("blob:")) URL.revokeObjectURL(completePreviewUrl);
  setCompletePreviewUrl(null);
  setCompletePreviewFile(null);
}

  // --- Helpers for rendering the buyer's attachment inline in the Complete modal ---
function buyerAttachmentSrc(id: number | string, apiBase: string) {
  return `${apiBase}/api/requests/${encodeURIComponent(String(id))}/attachment`;
}
function buyerAttachmentPoster(id: number | string, apiBase: string) {
  return `${apiBase}/api/requests/${encodeURIComponent(String(id))}/attachment/poster`;
}
function guessTypeFromKey(k: string) {
  const name = (k || "").toLowerCase();
  const isImg = /\.(png|jpe?g|webp|gif|svg)$/.test(name);
  const isVid = /\.(mp4|mov|m4v|webm|ogg)$/.test(name);
  const isAud = /\.(mp3|wav|m4a|aac|ogg|webm)$/.test(name);
  return { isImg, isVid, isAud };
}

    async function submitComplete() {
      if (!activeCompleteRequest) return;
      setCompleting(true);
      setUploadError(null);
      setUploadPct(null);

      try {
        const files = completeFilesRef.current?.files;
        const firstFile = files && files.length > 0 ? files[0] : null;

        if (firstFile) {
          // Try presigned path with progress
          try {
            setUploadPhase("presigning");
            const onProgress = (sent: number, total: number) => {
              setUploadPhase("uploading");
              if (total > 0) setUploadPct(Math.max(0, Math.min(100, Math.round((sent / total) * 100))));
            };
            const { key, contentType } = await presignAndUploadToPrivateBucketWithProgress(apiBase, firstFile, onProgress);
            if (!key) throw new Error("No key returned from presign/upload");

            setUploadPhase("finalizing");
            const res = await fetch(`${apiBase}/api/requests/${encodeURIComponent(activeCompleteRequest.id)}/complete`, {
              method: "POST",
              credentials: "include",
              headers: buildAuthHeaders({ "Content-Type": "application/json" }),
              body: JSON.stringify({ message: completeDesc || "", attachment_key: key, content_type: contentType || undefined }),
            });
            const payload: any = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(extractMessage(payload, `Failed to complete request ${activeCompleteRequest.id}`));

            setPendingRequests((prev) => prev.filter((r) => String(r.id) !== String(activeCompleteRequest.id)));
            closeComplete();
            showToast("Request marked complete");
            return;
          } catch (presignErr) {
            console.warn("Presigned upload failed, falling back to direct upload:", presignErr);
          }
        }

        // Legacy fallback (multipart) with progress
        const fd = new FormData();
        fd.append("description", completeDesc || "");
        const filesAll = completeFilesRef.current?.files;
        if (filesAll && filesAll.length > 0) fd.append("media", filesAll[0]);

        const onProgress = (sent: number, total: number) => {
          setUploadPhase("uploading");
          if (total > 0) setUploadPct(Math.max(0, Math.min(100, Math.round((sent / total) * 100))));
        };

        setUploadPhase(firstFile ? "uploading" : "finalizing");
        const payload: any = await uploadCompleteMultipartWithProgress(
          `${apiBase}/api/requests/${encodeURIComponent(activeCompleteRequest.id)}/complete`,
          fd,
          buildAuthHeaders() as Record<string,string>,
          onProgress,
        );

        if (!payload || payload.error) throw new Error(extractMessage(payload, "Could not complete request"));

        setPendingRequests((prev) => prev.filter((r) => String(r.id) !== String(activeCompleteRequest.id)));
        closeComplete();
        showToast("Request marked complete");
      } catch (err) {
        console.error("complete request error", err);
        setUploadError(err instanceof Error ? err.message : "Could not complete request");
        showToast(err instanceof Error ? err.message : "Could not complete request");
      } finally {
        setCompleting(false);
        setUploadPhase(null);
        setUploadPct(null);
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

    let data: any = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok) {
      showToast(extractMessage(data, "Could not start Stripe onboarding"));
      return;
    }

    const url = getStringProp(data, "url");
    const mode = getStringProp(data, "mode") || "";
    const alreadyConnected = !!data.already_connected;

    // New creator: we got an OAuth URL, send them into Stripe onboarding
    if (url) {
      window.location.href = url;
      return;
    }

    // Already connected to Stripe Standard:
    // send them to Stripe Dashboard or just tell them what to do
    if (alreadyConnected && mode === "standard") {
      // Easiest option: send them to dashboard.stripe.com
      window.location.href = "https://dashboard.stripe.com/";
      return;
    }

    // Fallback if the payload is not what we expect
    showToast("Could not start Stripe onboarding");
  } catch (e) {
    console.error("connectStripe error", e);
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

   const publicProfilePath = creator
    ? creatorProfilePath(creator.display_name, creator.creator_id)
    : creatorId
    ? creatorProfilePath(null, creatorId)
    : "/";
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

    const buildCreatorAttachmentPosterUrl = useCallback((requestId: string | number) => {
      return `${apiBase}/api/requests/${encodeURIComponent(requestId)}/attachment/poster`;
    }, [apiBase]);

      const handleDownloadAttachment = useCallback(async () => {
        try {
          if (!activeRequest?.id) return;

          // Same endpoint you already have (same-origin)
          const url = `${apiBase}/api/requests/${encodeURIComponent(activeRequest.id)}/attachment/file`;

          // 1) Try same-origin fetch -> blob (never navigates, works reliably with big files too)
          const res = await fetch(url, { credentials: "include" });
          if (!res.ok) throw new Error(`Download failed (${res.status})`);

          const blob = await res.blob();
          const objectUrl = URL.createObjectURL(blob);

          // filename hint from header if present
          const cd = res.headers.get("content-disposition") || "";
          const m = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(cd);
          const filename = m ? decodeURIComponent(m[1]) : `attachment-${activeRequest.id}`;

          const a = document.createElement("a");
          a.href = objectUrl;
          a.download = filename; // forces “Save as…”
          a.rel = "noopener";
          document.body.appendChild(a);
          a.click();

          setTimeout(() => {
            URL.revokeObjectURL(objectUrl);
            a.remove();
          }, 0);
        } catch (e) {
          console.error("download attachment error", e);

          // 2) Fallback: best-effort anchor click without leaving SPA
          try {
            const url = `${apiBase}/api/requests/${encodeURIComponent(activeRequest.id)}/attachment/file`;
            const a = document.createElement("a");
            a.href = url;
            a.download = ""; // hint if same-origin
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
          } catch {
            showToast("Download failed");
          }
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
                <span className="font-medium">{products.length}</span> Product(s)
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
                  These appear on the back of your creator card and public profile.
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
                    <div className="ml-2 shrink-0 flex flex-col gap-2 items-stretch">
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
                      <button
                        onClick={() =>
                          setDecisionDialog({
                            open: true,
                            requestId: req.id,
                            action: "decline",
                          })
                        }
                        disabled={decidingRequestId === req.id}
                        className="cursor-pointer text-xs px-3 py-1 rounded-md font-medium border border-red-500 text-red-600 hover:bg-red-50 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        Reject
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
              {decisionDialog.open && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                  <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-6">
                    <h3 className="text-lg font-semibold">Reject this request?</h3>
                    <p className="text-sm text-neutral-700">
                      The buyer will be refunded (minus Stripe processing fees) and you will
                      not be paid for this request.
                    </p>

                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() =>
                          setDecisionDialog({ open: false, requestId: null, action: null })
                        }
                        className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium bg-neutral-200 hover:bg-neutral-300"
                        disabled={decidingRequestId !== null}
                      >
                        Cancel
                      </button>

                      <button
                        onClick={async () => {
                          if (!decisionDialog.requestId || !decisionDialog.action) return;
                          await handleRequestDecision(
                            decisionDialog.requestId,
                            decisionDialog.action
                          );
                          setDecisionDialog({ open: false, requestId: null, action: null });
                        }}
                        className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-60"
                        disabled={decidingRequestId !== null}
                      >
                        {decidingRequestId === decisionDialog.requestId
                          ? "Rejecting..."
                          : "Yes, reject"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
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
                    <AttachmentViewer
                      src={buildCreatorAttachmentUrl(activeRequest.id)}
                      posterUrl={buildCreatorAttachmentPosterUrl(activeRequest.id)}
                    />
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
      accept={[
        "image/*",
        "video/*",
        "audio/*",
        ".mp3,.wav,.m4a,.aac,.ogg,.webm",
        "application/pdf,.pdf",
        "application/vnd.ms-excel,.xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx",
        "text/csv,.csv",
      ].join(",")}
      multiple={false}
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
    {/* ✅ PROGRESS GOES HERE */}
    {(uploadPhase || uploadPct !== null || uploadError) && (
      <div className="mt-3 space-y-2">
        {uploadPhase && (
          <div className="text-xs text-neutral-600">
            {uploadPhase === "presigning" && "Preparing upload…"}
            {uploadPhase === "uploading" && "Uploading…"}
            {uploadPhase === "finalizing" && "Finalizing…"}
          </div>
        )}

        {uploadPct !== null && (
          <div className="w-full h-2 rounded bg-neutral-200 overflow-hidden">
            <div
              className="h-2 bg-emerald-400 transition-all"
              style={{ width: `${uploadPct}%` }}
            />
          </div>
        )}

        {uploadError && (
          <div className="text-xs text-red-600">{uploadError}</div>
        )}
      </div>
    )}
    {/* ✅ END PROGRESS */}

    <div className="flex items-center justify-end gap-2">
      <button
        onClick={closeComplete}
        className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
        disabled={completing}
      >
        Cancel
      </button>

      <button
        onClick={submitComplete}
        className={`cursor-pointer rounded-lg px-4 py-2 text-sm font-medium text-black ${
          completing
            ? "bg-neutral-300"
            : "bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 hover:brightness-95"
        }`}
        disabled={completing || !completeDesc.trim()}
      >
        {completing
          ? uploadPct !== null
            ? `Uploading ${uploadPct}%…`
            : uploadPhase === "finalizing"
              ? "Finalizing…"
              : "Submitting…"
          : "Submit & Mark Complete"}
      </button>
    </div>
    {/* --- Buyer details & inline preview under actions --- */}
{activeCompleteRequest && (
  <div className="mt-4 space-y-3 border-t pt-4">
    {/* Description from buyer */}
    <div>
      <div className="text-sm font-bold">Buyer’s Description</div>
      <div className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">
        {String(activeCompleteRequest.user || "").trim() || "—"}
      </div>
    </div>

    {/* Inline preview of buyer's attachment (if any) */}
    {activeCompleteRequest.attachment_path ? (
      <div>
        <div className="text-sm font-bold mb-2">Buyer’s Attachment</div>
        {(() => {
          const { isImg, isVid, isAud } = guessTypeFromKey(
            activeCompleteRequest.attachment_path || ""
          );
          const src = buyerAttachmentSrc(activeCompleteRequest.id, apiBase);
          const poster = buyerAttachmentPoster(activeCompleteRequest.id, apiBase);

          if (isImg) {
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt="Buyer attachment"
                className="block w-full max-h-[60vh] object-contain rounded-lg bg-black"
              />
            );
          }
          if (isVid) {
            return (
              <video
                src={src}
                poster={poster}
                controls
                playsInline
                preload="metadata"
                className="block w-full max-h-[60vh] object-contain rounded-lg bg-black"
                crossOrigin="use-credentials"
              />
            );
          }
          if (isAud) {
            return (
              <audio
                src={src}
                controls
                preload="metadata"
                className="block w-full"
              />
            );
          }
          // Fallback: show a download link if we can't preview
          return (
            <a
              href={`${apiBase}/api/requests/${encodeURIComponent(
                String(activeCompleteRequest.id)
              )}/attachment/file`}
              className="inline-flex items-center gap-2 text-sm underline"
            >
              Download attachment
            </a>
          );
        })()}
      </div>
    ) : null}
  </div>
)}
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
