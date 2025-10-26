// app/purchases/page.tsx
"use client";

import { useEffect, useMemo, useState,useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { fetchApi } from "@/lib/api";
import { loadAuth } from "@/lib/auth";
import Image from "next/image";
import Link from "next/link";
import {
  Download, Eye, X, AlertCircle, Star, ChevronRight, Loader2,
  Calendar, CreditCard, Shield, ArrowRight
} from "lucide-react";

const isPdfCT   = (ct?: string | null) => ct?.toLowerCase() === "application/pdf";
const isCsvCT   = (ct?: string | null) =>
  /(^text\/csv$)|(^application\/csv$)/i.test(ct || "");
const isSheetCT = (ct?: string | null) =>
  /spreadsheetml|application\/vnd\.ms-excel/i.test(ct || "");

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

function guessFromExtension(url: string): "image" | "video" | "audio" | null {
  const clean = url.split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(clean)) return "image";
  if (/\.(mp4|m4v|mov|webm|avi|mkv)$/.test(clean)) return "video";
  if (/\.(mp3|m4a|aac|wav|ogg|webm)$/.test(clean)) return "audio";
  return null;
}

function typeFromContentType(ct: string | null): "image" | "video" | "audio" | "other" {
  if (!ct) return "other";
  const low = ct.toLowerCase();
  if (low.startsWith("image/")) return "image";
  if (low.startsWith("video/")) return "video";
  if (low.startsWith("audio/")) return "audio";
  return "other";
}

// Video component that matches the feed page implementation
function VideoWithPoster({
  src,
  posterSrc,
  className = "",
}: { src: string; posterSrc?: string; className?: string }) {
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
  const [zoomLevel, setZoomLevel] = useState(1);
  const [zoomOverlayVisible, setZoomOverlayVisible] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasPosterProp = Boolean(posterSrc?.trim());
  
// Resolve poster by using the API URL directly (let <img>/<video> follow 302s)
useEffect(() => {
  const url = posterSrc?.trim() || null;
  setResolvedPoster(url);
  setPosterLoading(false);
}, [posterSrc]);

  // Generate client-side poster from video first frame if no backend poster
  const generateClientPoster = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.readyState < 2) {
      console.log('[VideoWithPoster] Cannot generate poster - video not ready, readyState:', v?.readyState);
      return;
    }
    
    if (v.videoWidth === 0 || v.videoHeight === 0) {
      console.log('[VideoWithPoster] Cannot generate poster - video dimensions are 0');
      return;
    }
    
    try {
      console.log('[VideoWithPoster] Generating client-side poster...');
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        console.error('[VideoWithPoster] Failed to get canvas context');
        return;
      }
      
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          setClientGeneratedPoster((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return url;
          });
          console.log('[VideoWithPoster] ✓ Client-side poster generated successfully');
        }
      }, 'image/jpeg', 0.85);
    } catch (err) {
      console.error('[VideoWithPoster] Error generating client-side poster:', err);
    }
  }, []);

  // Generate poster at current video time when paused
  const generatePausedFramePoster = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.readyState < 2) {
      console.log('[VideoWithPoster] Cannot generate paused frame - video not ready');
      return;
    }
    
    if (v.videoWidth === 0 || v.videoHeight === 0) {
      console.log('[VideoWithPoster] Cannot generate paused frame - video dimensions are 0');
      return;
    }
    
    try {
      console.log('[VideoWithPoster] Generating paused frame poster at time:', v.currentTime);
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      if (!ctx) {
        console.error('[VideoWithPoster] Failed to get canvas context');
        return;
      }
      
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      
      // Use toDataURL for immediate synchronous result to avoid black flash
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setPausedFramePoster((prev) => {
          if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
          return dataUrl;
        });
        console.log('[VideoWithPoster] ✓ Paused frame poster generated successfully (sync)');
      } catch (err) {
        // Fallback to blob if toDataURL fails (e.g., tainted canvas)
        console.warn('[VideoWithPoster] toDataURL failed, falling back to blob:', err);
        canvas.toBlob((blob) => {
          if (blob) {
            const url = URL.createObjectURL(blob);
            setPausedFramePoster((prev) => {
              if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
              return url;
            });
            console.log('[VideoWithPoster] ✓ Paused frame poster generated successfully (blob)');
          }
        }, 'image/jpeg', 0.85);
      }
    } catch (err) {
      console.error('[VideoWithPoster] Error generating paused frame poster:', err);
    }
  }, []);

  // Attempt to generate client-side poster if no backend poster provided
  useEffect(() => {
    // Only generate if we don't have a backend poster
    if (hasPosterProp || !src) return;
    
    const v = videoRef.current;
    if (!v) return;
    
    console.log('[VideoWithPoster] No backend poster - will attempt client-side generation');
    
    // Try multiple approaches for mobile compatibility
    const attemptGeneration = () => {
      setTimeout(() => {
        if (v.readyState >= 2 && v.videoWidth > 0) {
          generateClientPoster();
        }
      }, 100);
    };
    
    // Listen to multiple events for better mobile support
    const handleLoadedData = () => {
      console.log('[VideoWithPoster] Video loadeddata event, readyState:', v.readyState);
      attemptGeneration();
    };
    
    const handleLoadedMetadata = () => {
      console.log('[VideoWithPoster] Video loadedmetadata event, readyState:', v.readyState);
      // Try to load some data for poster generation
      if (v.readyState < 2) {
        v.load();
      }
    };
    
    const handleCanPlay = () => {
      console.log('[VideoWithPoster] Video canplay event, readyState:', v.readyState);
      attemptGeneration();
    };
    
    v.addEventListener('loadedmetadata', handleLoadedMetadata);
    v.addEventListener('loadeddata', handleLoadedData);
    v.addEventListener('canplay', handleCanPlay);
    
    // If video is already ready, try immediately
    if (v.readyState >= 2) {
      attemptGeneration();
    }
    
    return () => {
      v.removeEventListener('loadedmetadata', handleLoadedMetadata);
      v.removeEventListener('loadeddata', handleLoadedData);
      v.removeEventListener('canplay', handleCanPlay);
    };
  }, [hasPosterProp, src, generateClientPoster]);

  // Use resolved poster (blob URL) if available, otherwise client-generated, otherwise undefined
    const effectivePoster = useMemo(() => {
      if (pausedFramePoster && !isPlaying) return pausedFramePoster;
      if (resolvedPoster) return resolvedPoster;         // now the API URL
      if (clientGeneratedPoster) return clientGeneratedPoster;
      return undefined;
    }, [resolvedPoster, clientGeneratedPoster, pausedFramePoster, isPlaying])

  // Cleanup client-generated poster on unmount
  useEffect(() => {
    return () => {
      if (clientGeneratedPoster && clientGeneratedPoster.startsWith('blob:')) {
        URL.revokeObjectURL(clientGeneratedPoster);
      }
      if (pausedFramePoster && pausedFramePoster.startsWith('blob:')) {
        URL.revokeObjectURL(pausedFramePoster);
      }
    };
  }, [clientGeneratedPoster, pausedFramePoster]);

  // Update poster overlay visibility when effectivePoster becomes available or playing state changes
  useEffect(() => {
    console.log('[VideoWithPoster] Poster visibility check - effectivePoster:', Boolean(effectivePoster), 'isPlaying:', isPlaying, 'videoReady:', videoReady);
    
    // Show poster overlay when we have a poster and video is not playing
    if (effectivePoster && !isPlaying) {
      console.log('[VideoWithPoster] Setting showPosterOverlay=true (poster available, not playing)');
      setShowPosterOverlay(true);
    } else if (isPlaying) {
      console.log('[VideoWithPoster] Hiding poster overlay (video is playing)');
      setShowPosterOverlay(false);
    }
    // If no poster and not playing, let the video element show its own state
  }, [effectivePoster, isPlaying, videoReady]);

  // Ensure inline playback on iPhone Safari and set initial state
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
      
      // Try to seek to a small time to show first frame
      const handleCanPlayThrough = () => {
        if (v.currentTime === 0 && v.duration > 0) {
          v.currentTime = 0.01; // Very small seek to ensure first frame shows
        }
      };
      
      // Handle video native fullscreen (iOS Safari)
      const handleVideoFullscreenChange = () => {
        // On iOS, video can enter fullscreen natively
        // We should sync our state when this happens
        try {
          if ((v as any).webkitDisplayingFullscreen) {
            setIsFullscreen(true);
          } else {
            // Only set to false if we're not in document fullscreen
            const isDocumentFullscreen = !!(
              document.fullscreenElement ||
              (document as any).webkitFullscreenElement ||
              (document as any).mozFullScreenElement ||
              (document as any).msFullscreenElement
            );
            if (!isDocumentFullscreen) {
              setIsFullscreen(false);
            }
          }
        } catch (err) {
          // Ignore errors accessing webkit properties
        }
      };
      
      v.addEventListener('canplaythrough', handleCanPlayThrough, { once: true });
      v.addEventListener('webkitbeginfullscreen', handleVideoFullscreenChange);
      v.addEventListener('webkitendfullscreen', handleVideoFullscreenChange);
      
      // Ensure initial state is correct
      setIsPlaying(false);
      setShowPosterOverlay(true);
      
      console.log('[VideoWithPoster] Video element initialized, paused');
      
      return () => {
        v.removeEventListener('canplaythrough', handleCanPlayThrough);
        v.removeEventListener('webkitbeginfullscreen', handleVideoFullscreenChange);
        v.removeEventListener('webkitendfullscreen', handleVideoFullscreenChange);
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
    console.log('[VideoWithPoster] Fullscreen toggle - isIOS:', isIOS, 'isMobile:', isMobile, 'current state:', isFullscreen);

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

    console.log('[VideoWithPoster] Document fullscreen state:', isDocumentFullscreen);

    if (!isFullscreen) {
      // Entering fullscreen
      console.log('[VideoWithPoster] Attempting to enter fullscreen');
      
      // For mobile devices or when fullscreen API is not available, use CSS fallback directly
      if (isMobile || !container.requestFullscreen) {
        console.log('[VideoWithPoster] Using CSS fallback for mobile/unsupported browser');
        setIsFullscreen(true);
        return;
      }

      // Try native fullscreen API for desktop browsers
      const requestFullscreen = 
        container.requestFullscreen ||
        (container as any).webkitRequestFullscreen ||
        (container as any).webkitRequestFullScreen ||
        (container as any).mozRequestFullScreen ||
        (container as any).msRequestFullscreen;

      if (requestFullscreen) {
        requestFullscreen.call(container).then(() => {
          console.log('[VideoWithPoster] ✓ Native fullscreen enabled');
          setIsFullscreen(true);
        }).catch((err: any) => {
          console.log('[VideoWithPoster] Native fullscreen failed, using CSS fallback:', err.message);
          setIsFullscreen(true);
        });
      } else {
        console.log('[VideoWithPoster] Fullscreen API not available, using CSS fallback');
        setIsFullscreen(true);
      }
    } else {
      // Exiting fullscreen
      console.log('[VideoWithPoster] Attempting to exit fullscreen');
      
      // For mobile or CSS fallback, always just toggle state
      if (isMobile || !isDocumentFullscreen) {
        console.log('[VideoWithPoster] Exiting CSS fallback fullscreen');
        setIsFullscreen(false);
        return;
      }

      // Try to exit native fullscreen for desktop
      const exitFullscreen = 
        document.exitFullscreen ||
        (document as any).webkitExitFullscreen ||
        (document as any).webkitCancelFullScreen ||
        (document as any).mozCancelFullScreen ||
        (document as any).msExitFullscreen;

      if (exitFullscreen) {
        exitFullscreen.call(document).then(() => {
          console.log('[VideoWithPoster] ✓ Native fullscreen exited');
          setIsFullscreen(false);
        }).catch((err: any) => {
          console.log('[VideoWithPoster] Native fullscreen exit failed, forcing state change:', err.message);
          setIsFullscreen(false);
        });
      } else {
        console.log('[VideoWithPoster] Exit fullscreen API not available, forcing state change');
        setIsFullscreen(false);
      }
    }
  }, [isFullscreen]);

  // Listen for fullscreen changes - handle all browser prefixes
  useEffect(() => {
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
      
      console.log('[VideoWithPoster] Fullscreen change detected - native fullscreen:', isFullscreenNow);
      
      // On mobile, we primarily rely on our CSS state, but update if native fullscreen changes
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
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        console.log('[VideoWithPoster] ESC key pressed - exiting fullscreen');
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

  // Handle mobile viewport and prevent scrolling in fullscreen
  useEffect(() => {
    if (isFullscreen) {
      // Prevent scrolling on mobile when in fullscreen
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      
      // Lock screen orientation if possible (for mobile devices)
      if ('screen' in window && 'orientation' in (window as any).screen) {
        try {
          (window as any).screen.orientation.lock('landscape').catch(() => {
            // Orientation lock failed, ignore
          });
        } catch (err) {
          // Orientation lock not supported, ignore
        }
      }
    } else {
      // Restore scrolling
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
      
      // Unlock orientation
      if ('screen' in window && 'orientation' in (window as any).screen) {
        try {
          (window as any).screen.orientation.unlock();
        } catch (err) {
          // Orientation unlock not supported, ignore
        }
      }
    }

    return () => {
      // Cleanup on unmount
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    };
  }, [isFullscreen]);

  const isVideo = true; // Always true for VideoWithPoster component
  
  return (
    <div className={`relative ${className}`}>
      <div 
        ref={containerRef}
        className={`w-full rounded-xl overflow-hidden ring-1 ring-neutral-200 ${isFullscreen ? 'fixed inset-0 z-[9999] bg-black flex items-center justify-center rounded-none ring-0' : ''}`}
        style={isFullscreen ? {
          width: '100vw',
          height: '100vh',
          minHeight: '100vh',
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 9999,
          padding: '0',
          margin: '0',
        } : undefined}
      >
        {/* Mobile Fullscreen Exit Helper - tap anywhere to exit */}
        {isFullscreen && (
          <div 
            className="absolute inset-0 z-[1] bg-transparent cursor-pointer md:hidden"
            onClick={(e) => {
              // Only handle background clicks, not clicks on video or controls
              if (e.target === e.currentTarget) {
                console.log('[VideoWithPoster] Mobile background tap detected - exiting fullscreen');
                setIsFullscreen(false);
              }
            }}
            onTouchEnd={(e) => {
              // iOS-specific touch handler for better reliability
              if (e.target === e.currentTarget) {
                e.preventDefault();
                e.stopPropagation();
                console.log('[VideoWithPoster] iOS background touch detected - exiting fullscreen');
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
              console.log('[VideoWithPoster] iOS large exit button clicked');
              setIsFullscreen(false);
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              e.stopPropagation();
              console.log('[VideoWithPoster] iOS large exit button touched');
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
            src={src}
            playsInline
            preload="metadata"
            poster={effectivePoster || posterSrc}
            onLoadedMetadata={() => {
              const v = videoRef.current;
              const d = v?.duration || 0;
              setDuration(isFinite(d) ? d : 0);
              updateBuffered();
              setVideoReady(true);
              console.log('[VideoWithPoster] Video metadata loaded, duration:', d, 'readyState:', v?.readyState, 'hasEffectivePoster:', Boolean(effectivePoster));
              
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
              console.log('[VideoWithPoster] Video data loaded, readyState:', v?.readyState);
              setVideoReady(true);
              
              // Generate client poster if no backend poster and video is ready
              if (!hasPosterProp && v && v.readyState >= 2 && v.videoWidth > 0) {
                console.log('[VideoWithPoster] Attempting to generate first frame poster');
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
              console.error('[VideoWithPoster] Video error:', e);
              const v = videoRef.current;
              if (v) {
                console.error('[VideoWithPoster] Video src:', v.currentSrc);
                console.error('[VideoWithPoster] Video poster:', v.poster);
                console.error('[VideoWithPoster] Video error code:', v.error?.code, v.error?.message);
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
              console.log('[VideoWithPoster] Video paused');
              setIsPlaying(false);
              clearOverlayTimer();
              setOverlayVisible(true);
              const v = videoRef.current;
              
              // Always generate and show poster when paused
              if (v && v.currentTime > 0.01) {
                // Generate immediately without delay to avoid black flash
                generatePausedFramePoster();
                // Force show overlay immediately
                setShowPosterOverlay(true);
              } else {
                // At the beginning, show existing poster or generate one
                if (effectivePoster) {
                  setShowPosterOverlay(true);
                } else if (v) {
                  // Generate even at start if no poster exists
                  generatePausedFramePoster();
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
                  console.log('[VideoWithPoster] ✓ Poster overlay image loaded and visible:', effectivePoster.substring(0, 50));
                }}
                onError={(e) => {
                  console.error('[VideoWithPoster] ✗ Poster overlay image failed to load:', effectivePoster.substring(0, 50));
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
              className={`absolute z-10 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 inline-flex items-center justify-center ${
                isFullscreen ? 'h-20 w-20' : 'h-14 w-14'
              } rounded-full bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 focus:outline-none focus:ring-2 focus:ring-white/60 transition-all duration-200 touch-manipulation`}
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
                    console.log('[VideoWithPoster] iOS fullscreen button - direct toggle');
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
                    console.log('[VideoWithPoster] iOS touch end - direct toggle');
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
  posterSrc,
  className = "w-full rounded-lg border overflow-hidden bg-black/5",
}: { src: string; posterSrc?: string; className?: string }) {
  const [kind, setKind] = useState<"image"|"video"|"audio"|"other" | null>(guessFromExtension(src));
  const [errored, setErrored] = useState(false);
  const [contentType, setContentType] = useState<string | undefined>(undefined);

  useEffect(() => {
    let aborted = false;
    setErrored(false);

    (async () => {
      // Try to resolve the true content-type from /delivery/meta
      const m = /\/api\/requests\/(\d+)\/delivery\b/.exec(src);
      if (m) {
        const apiBase = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");
        try {
          const res = await fetch(`${apiBase}/api/requests/${m[1]}/delivery/meta`, { credentials: "include" });
          if (!aborted && res.ok) {
            const { contentType: ct } = await res.json();
            setContentType(ct || undefined);
            setKind(typeFromContentType(ct) ?? "other");
            return;
          }
        } catch { /* ignore, fall through */ }
      }
      // Fallback: keep existing guess (may be null)
      if (!aborted && !kind) setKind("other");
    })();

    return () => { aborted = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (errored) {
    // last-ditch: give them a link
    return <a href={src} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">Open attachment</a>;
  }

  if (kind === "image") {
    return <img src={src} alt="attachment" className={`${className} object-contain`} onError={() => setErrored(true)} />;
  }

  if (kind === "video") {
    // only pass posterSrc for videos
    return <VideoWithPoster src={src} posterSrc={posterSrc} className={className} />;
  }

  if (kind === "audio") {
    return <audio src={src} controls preload="metadata" className={`${className} block`} onError={() => setErrored(true)} />;
  }

  // ---------- OTHER (PDF/CSV/XLSX/etc.) ----------
  // Prefer inline PDF preview; otherwise show a clean download/open UI.
  if (isPdfCT(contentType ?? undefined)) {
    return (
      <div className={className}>
        <iframe
          src={src} // 302 → signed CF URL with application/pdf; renders inline
          title="PDF"
          className="w-full h-[70vh] bg-white"
        />
      </div>
    );
  }

  // For CSV/XLS/XLSX just provide an open/download action (embedding spreadsheets is messy)
  if (isCsvCT(contentType ?? undefined) || isSheetCT(contentType ?? undefined)) {
    return (
      <div className={`${className} p-4 flex items-center justify-between bg-white`}>
        <div className="text-sm text-gray-700">
          {contentType?.includes("spreadsheet") ? "Spreadsheet" : "Data file"} ready.
        </div>
        <a
          href={src}
          className="inline-flex items-center px-3 py-2 rounded-md bg-emerald-600 text-white text-sm"
          rel="noopener"
        >
          Download
        </a>
      </div>
    );
  }

  // Unknown generic file
  return (
    <div className={`${className} p-4 flex items-center justify-between bg-white`}>
      <div className="text-sm text-gray-700">File ready.</div>
      <a href={src} className="inline-flex items-center px-3 py-2 rounded-md bg-emerald-600 text-white text-sm" rel="noopener">
        Download
      </a>
    </div>
  );
}

function ProfileAvatar({
  src,
  alt,
  size = 56,                 // px; 56 = w-14 h-14
  creatorId,
  className = "",
  ringClass = "ring-2 ring-white shadow-lg", // or "ring-2 ring-gray-100" for list rows
}: {
  src: string | null | undefined;
  alt: string;
  size?: number;
  creatorId?: number | null | undefined;
  className?: string;
  ringClass?: string;
}) {
  const img = (
    <div
      className={`relative rounded-full overflow-hidden bg-neutral-200 ${ringClass} ${className}`}
      style={{ width: size, height: size }}
    >
      <Image
        src={src || "/default-avatar.png"}
        alt={alt}
        fill
        sizes={`${size}px`}          // lets Retina/hi-DPI pick 2x automatically
        className="object-cover object-center"
        quality={92}
        priority={false}
        style={{ imageOrientation: "from-image" as any }}
      />
    </div>
  );

  // Make it clickable/tappable if we have an id
  return creatorId
    ? (
        <Link
          href={`/creators/${creatorId}`}
          aria-label={`View ${alt}`}
          title={`View ${alt}`}
          className="outline-none focus:ring-2 focus:ring-emerald-500 rounded-full"
        >
          {img}
        </Link>
      )
    : img;
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

const downloadRequestDelivery = async (requestId: number) => {
  await downloadByUrl(`${apiBase}/api/requests/${encodeURIComponent(requestId)}/download`);
};

const handleDownload = async (item: Order) => {
  if (!item.product_id) return;
  // optional nicer filename if you have it:
  const fname = item.product?.filename || `${item.product?.title || "download"}`.replace(/[^\w.\- ]+/g, "_");
  await downloadByUrl(`${apiBase}/api/downloads/file/${encodeURIComponent(item.product_id)}`, fname);
};

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

  const downloadByUrl = useCallback(async (href: string, filename?: string) => {
  try {
    const res = await fetch(href, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const blobUrl = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename || href.split("?")[0].split("/").pop() || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(blobUrl);
  } catch {
    // fallback if fetch fails
    window.open(href, "_blank", "noopener");
  }
}, []);

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
      className={`relative flex-1 cursor-pointer py-4 px-6 text-sm font-medium transition-all duration-300 ${
        activeTab === tab ? "text-gray-900" : "text-gray-500 hover:text-gray-700"
      }`}
    >
      <div className="flex items-center justify-center gap-2">
        {icon}
        <span className="flex items-center gap-0.5">
          <span>{label}</span>
          {count > 0 && (
            <span
              className={`px-1.5 py-0.5 text-[10px] sm:text-xs rounded-full ${
                activeTab === tab ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"
              }`}
            >
              {count}
            </span>
          )}
        </span>
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
          <h1 className="text-3xl font-bold text-gray-900">My Purchases</h1>
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
                    <div className="aspect-w-16 aspect-h-9 bg-gradient-to-r from-emerald-100 via-cyan-100 to-sky-100 p-6">
                      <div className="flex items-center space-x-4">
                          <ProfileAvatar
                            src={resolveImageUrl(m.creator_profile?.profile_image, apiBase)}
                            alt={m.creator_profile?.display_name || "Creator"}
                            size={64}
                            creatorId={m.creator_profile?.user_id}
                            ringClass="ring-4 ring-white shadow-lg"
                          />
                        <div>
                          {m.membership_cancel_at_period_end && m.membership_period_end ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                              Active until {formatDate(m.membership_period_end)}
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              Active Membership
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
                          className="cursor-pointer w-full bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 text-black px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors duration-200 flex items-center justify-center group"
                        >
                          View Feed
                          <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                        </button>

                        <div className="flex space-x-2">
                          {!m.user_has_review && (
                            <button
                              onClick={() => setShowReviewModal(m)}
                              className="cursor-pointer flex-1 text-gray-600 hover:text-gray-900 text-sm font-medium py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors duration-200 flex items-center justify-center"
                            >
                              <Star className="w-4 h-4 mr-1" />
                              Review
                            </button>
                          )}
                          {!m.membership_cancel_at_period_end && (
                            <button
                              onClick={() => setShowCancelConfirm(m.id)}
                              className="cursor-pointer flex-1 text-red-600 hover:text-red-700 text-sm font-medium py-2 px-3 rounded-lg hover:bg-red-50 transition-colors duration-200"
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

                  const isComplete = ["delivered", "complete"].includes(
                     (r.request_status || "").toLowerCase()
                  );

                  return (
                    <div key={r.id} className="bg-white rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 p-6">
                      <div className="flex items-start space-x-4">
                          <ProfileAvatar
                            src={resolveImageUrl(r.creator_profile?.profile_image, apiBase)}
                            alt={r.creator_profile?.display_name || "Creator"}
                            size={56}
                            creatorId={r.creator_profile?.user_id}
                            ringClass="ring-2 ring-gray-100"
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
                              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-red-100 text-gray-700">
                                <div className="w-1.5 h-1.5 bg-red-500 rounded-full mr-1.5" />
                                Action Needed
                              </span>
                            )}
                          </div>

                          <div className="mt-4">
                            {isComplete ? (
                              <div className="flex items-center space-x-3">
                                <button
                                  onClick={() => setSelectedItem(r)}
                                  className="cursor-pointer bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 text-black px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors duration-200 inline-flex items-center"
                                >
                                  <Eye className="w-4 h-4 mr-2" />
                                  View Response
                                </button>
                                {!r.user_has_review && (
                                  <button
                                    onClick={() => setShowReviewModal(r)}
                                    className="cursor-pointer text-gray-600 hover:text-gray-900 text-sm font-medium py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors duration-200 inline-flex items-center"
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
                                  className="cursor-pointer text-blue-600 hover:text-blue-700 text-sm font-medium inline-flex items-center"
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
                                  className="cursor-pointer bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:emerald-700 transition-colors duration-200 inline-flex items-center"
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
                          <ProfileAvatar
                            src={resolveImageUrl(p.creator_profile?.profile_image, apiBase)}
                            alt={p.creator_profile?.display_name || "Creator"}
                            size={56}
                            creatorId={p.creator_profile?.user_id}
                            ringClass="ring-2 ring-gray-100"
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
                            className="cursor-pointer bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 text-black px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors duration-200 inline-flex items-center"
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Download
                          </button>
                          {!p.user_has_review && (
                            <button
                              onClick={() => setShowReviewModal(p)}
                              className="cursor-pointer text-gray-600 hover:text-gray-900 text-sm font-medium py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors duration-200 inline-flex items-center"
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
                {/* Request header */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="font-medium text-gray-700 mb-2">Request</h4>
                  <h5 className="font-semibold text-gray-900">{selectedItem.product.title}</h5>
                  {selectedItem.product.description && (
                    <p className="text-gray-600 mt-2">{selectedItem.product.description}</p>
                  )}
                </div>

                  {/* Buyer-submitted details */}
                  {(selectedItem.request_user_message || selectedItem.request_user_attachment_url) && (
                    <div>
                      <h4 className="font-medium text-gray-700 mb-3">Your Submitted Details</h4>

                      {selectedItem.request_user_message && (
                        <div className="bg-gray-50 rounded-lg p-4 mb-3">
                          <p className="text-gray-700 whitespace-pre-wrap">
                            {selectedItem.request_user_message}
                          </p>
                        </div>
                      )}
                      {selectedItem.request_id && selectedItem.request_user_attachment_url && (
                        <div className="space-y-3">
                          <button
                            type="button"
                            onClick={() =>
                                downloadByUrl(
                                  `${apiBase}/api/requests/${encodeURIComponent(
                                    selectedItem.request_id!
                                  )}/my-attachment/file`
                                )
                              }
                            className="inline-flex items-center bg-blue-100 text-blue-700 px-4 py-2.5 rounded-lg hover:bg-blue-200 transition-colors"
                          >
                            <Download className="w-5 h-5 mr-2" />
                            Download Your Attachment
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                {/* Creator delivery (shown when creator attached a file on deliver/complete) */}
                {selectedItem.request_media_url && (
                  <div>
                    <h4 className="font-medium text-gray-700 mb-3">Creator’s Delivery</h4>

                    {/* Inline preview from protected route */}
                      {selectedItem?.request_id && (
                        <AttachmentViewer
                          src={`${apiBase}/api/requests/${encodeURIComponent(selectedItem.request_id)}/delivery`}
                          posterSrc={`${apiBase}/api/requests/${encodeURIComponent(selectedItem.request_id)}/delivery/poster`}
                        />
                      )}

                    <div className="mt-3 flex flex-wrap gap-2">
                      {/* Download from protected route */}
                      {selectedItem.request_id && (
                        <button
                          type="button"
                          onClick={() => {
                          downloadRequestDelivery(selectedItem.request_id!);
                          }}
                          className="inline-flex items-center bg-green-100 text-green-800 px-4 py-2.5 rounded-lg hover:bg-green-200 transition-colors"
                        >
                          <Download className="w-5 h-5 mr-2" />
                          Download Delivery
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {/* Creator text notes (if they wrote something) */}
                {selectedItem.request_response && (
                  <div>
                    <h4 className="font-medium text-gray-700 mb-3">Creator’s Notes</h4>
                    <div className="bg-green-50 rounded-lg p-4">
                      <p className="text-gray-700 whitespace-pre-wrap">
                        {selectedItem.request_response}
                      </p>
                    </div>
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
                  className="flex-1 cursor-pointer bg-gray-100 text-gray-700 px-4 py-2.5 rounded-lg font-medium hover:bg-gray-200 transition-colors duration-200"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmitReview}
                  disabled={!reviewText.trim()}
                  className="flex-1 cursor-pointer bg-green-600 text-white px-4 py-2.5 rounded-lg font-medium hover:bg-green-700 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
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
