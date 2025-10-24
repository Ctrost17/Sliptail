// src/app/feed/page.tsx
"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { fetchApi } from "@/lib/api";
import { loadAuth } from "@/lib/auth";
import Image from "next/image";

interface Product { id: number; creator_id: number; title: string | null; description: string | null; created_at?: string; display_name?: string; profile_image?: string; }
interface Post { id: number; creator_id: number; title: string | null; body: string | null; media_path: string | null; media_poster?: string | null; created_at: string; product_id?: number; profile_image?: string; }
interface MeResponse { user?: { id: number; role?: string; }; }

// === Direct-to-S3 upload helpers (ADD THIS) ===

/** Low-level PUT upload with progress + cancel support. */
function putFileWithProgress(
  url: string,
  file: File,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        const pct = Math.max(0, Math.min(100, Math.round((e.loaded / e.total) * 100)));
        onProgress(pct);
      }
    };

    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed with status ${xhr.status}`));
    };

    if (signal) {
      if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener(
        "abort",
        () => {
          try { xhr.abort(); } catch {}
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );
    }

    xhr.send(file);
  });
}

/** Presign on your API, then upload the file directly to S3. Returns the S3 object key. */
async function presignAndUploadToS3(opts: {
  apiBase: string;
  token?: string;
  file: File;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { apiBase, token, file, onProgress, signal } = opts;

  // 1) Ask backend for a presigned PUT URL
  const presignRes = await fetch(`${apiBase}/api/uploads/presign-post`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || "application/octet-stream",
    }),
  });
  if (!presignRes.ok) throw new Error(`Presign failed (${presignRes.status})`);
  const presign = await presignRes.json(); // { key, url, contentType }

  if (!presign?.url || !presign?.key) throw new Error("Invalid presign response");

  // 2) Upload directly to S3
  await putFileWithProgress(presign.url, file, onProgress, signal);

  // 3) Return the S3 object key for /api/posts
  return presign.key;
}

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
  const [clientGeneratedPoster, setClientGeneratedPoster] = useState<string | null>(null);
  const [pausedFramePoster, setPausedFramePoster] = useState<string | null>(null);
  const [posterLoading, setPosterLoading] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hasPosterProp = Boolean(poster?.trim());
  
  // Resolve poster via fetch (handles protected endpoints with credentials)
  // This is crucial for mobile browsers that don't pass credentials with the poster attribute
  useEffect(() => {
    let revoke: string | null = null;
    setResolvedPoster(null);
    const url = poster?.trim();
    if (!url) {
      console.log('[PostMedia] No poster URL provided from backend for:', src);
      return;
    }
    
    setPosterLoading(true);
    console.log('[PostMedia] Fetching poster with credentials:', url);
    
    (async () => {
      try {
        const res = await fetch(url, { credentials: "include", cache: "no-store" });
        if (!res.ok) {
          console.warn('[PostMedia] Poster fetch failed:', res.status, res.statusText);
          setPosterLoading(false);
          return;
        }
        const ct = res.headers.get("content-type") || "";
        if (!ct.toLowerCase().startsWith("image/")) {
          console.warn('[PostMedia] Poster is not an image, content-type:', ct);
          setPosterLoading(false);
          return;
        }
        const blob = await res.blob();
        const obj = URL.createObjectURL(blob);
        revoke = obj;
        setResolvedPoster(obj);
        setPosterLoading(false);
        console.log('[PostMedia] ✓ Poster blob created successfully');
      } catch (err) {
        console.error('[PostMedia] Error fetching poster:', err);
        setPosterLoading(false);
      }
    })();
    
    return () => { 
      if (revoke) URL.revokeObjectURL(revoke);
      setPosterLoading(false);
    };
  }, [poster, src]);

  // Generate client-side poster from video first frame if no backend poster
  // This is a fallback for when the backend doesn't provide a poster
  const generateClientPoster = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.readyState < 2) {
      console.log('[PostMedia] Cannot generate poster - video not ready, readyState:', v?.readyState);
      return;
    }
    
    if (v.videoWidth === 0 || v.videoHeight === 0) {
      console.log('[PostMedia] Cannot generate poster - video dimensions are 0');
      return;
    }
    
    try {
      console.log('[PostMedia] Generating client-side poster...');
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        console.error('[PostMedia] Failed to get canvas context');
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
          console.log('[PostMedia] ✓ Client-side poster generated successfully');
        }
      }, 'image/jpeg', 0.85);
    } catch (err) {
      console.error('[PostMedia] Error generating client-side poster:', err);
    }
  }, []);

  // Generate poster at current video time when paused
  const generatePausedFramePoster = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.readyState < 2) {
      console.log('[PostMedia] Cannot generate paused frame - video not ready');
      return;
    }
    
    if (v.videoWidth === 0 || v.videoHeight === 0) {
      console.log('[PostMedia] Cannot generate paused frame - video dimensions are 0');
      return;
    }
    
    try {
      console.log('[PostMedia] Generating paused frame poster at time:', v.currentTime);
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      if (!ctx) {
        console.error('[PostMedia] Failed to get canvas context');
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
        console.log('[PostMedia] ✓ Paused frame poster generated successfully (sync)');
      } catch (err) {
        // Fallback to blob if toDataURL fails (e.g., tainted canvas)
        console.warn('[PostMedia] toDataURL failed, falling back to blob:', err);
        canvas.toBlob((blob) => {
          if (blob) {
            const url = URL.createObjectURL(blob);
            setPausedFramePoster((prev) => {
              if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
              return url;
            });
            console.log('[PostMedia] ✓ Paused frame poster generated successfully (blob)');
          }
        }, 'image/jpeg', 0.85);
      }
    } catch (err) {
      console.error('[PostMedia] Error generating paused frame poster:', err);
    }
  }, []);

  // Attempt to generate client-side poster if no backend poster provided
  useEffect(() => {
    // Only generate if we don't have a backend poster
    if (hasPosterProp || !src) return;
    
    const v = videoRef.current;
    if (!v) return;
    
    console.log('[PostMedia] No backend poster - will attempt client-side generation');
    
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
      console.log('[PostMedia] Video loadeddata event, readyState:', v.readyState);
      attemptGeneration();
    };
    
    const handleLoadedMetadata = () => {
      console.log('[PostMedia] Video loadedmetadata event, readyState:', v.readyState);
      // Try to load some data for poster generation
      if (v.readyState < 2) {
        v.load();
      }
    };
    
    const handleCanPlay = () => {
      console.log('[PostMedia] Video canplay event, readyState:', v.readyState);
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
    console.log('[PostMedia] Computing effectivePoster - paused:', pausedFramePoster?.substring(0,30), 'resolved:', resolvedPoster?.substring(0,30), 'client:', clientGeneratedPoster?.substring(0,30), 'isPlaying:', isPlaying);
    
    // If video was paused, show the paused frame
    if (pausedFramePoster && !isPlaying) {
      console.log('[PostMedia] ✓ Using paused frame poster');
      return pausedFramePoster;
    }
    if (resolvedPoster) {
      console.log('[PostMedia] ✓ Using resolved backend poster blob');
      return resolvedPoster;
    }
    if (clientGeneratedPoster) {
      console.log('[PostMedia] ✓ Using client-generated poster');
      return clientGeneratedPoster;
    }
    // If no poster available and not loading, rely on browser's preload
    console.log('[PostMedia] ✗ No poster available - posterLoading:', posterLoading, 'hasPosterProp:', hasPosterProp);
    return undefined;
  }, [resolvedPoster, clientGeneratedPoster, pausedFramePoster, isPlaying, posterLoading, hasPosterProp]);

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
    console.log('[PostMedia] Poster visibility check - effectivePoster:', Boolean(effectivePoster), 'isPlaying:', isPlaying, 'videoReady:', videoReady);
    
    // Show poster overlay when we have a poster and video is not playing
    if (effectivePoster && !isPlaying) {
      console.log('[PostMedia] Setting showPosterOverlay=true (poster available, not playing)');
      setShowPosterOverlay(true);
    } else if (isPlaying) {
      console.log('[PostMedia] Hiding poster overlay (video is playing)');
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
      
      // Ensure initial state is correct
      setIsPlaying(false);
      setShowPosterOverlay(true);
      
      console.log('[PostMedia] Video element initialized, paused');
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
      // Hide poster overlay immediately when initiating play
      setShowPosterOverlay(false);
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, []);

  const handleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Detect specific devices for better handling
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    console.log('[PostMedia] Fullscreen toggle - isIOS:', isIOS, 'isMobile:', isMobile, 'current state:', isFullscreen);

    // For iPhone/iOS, always use CSS-only approach since Fullscreen API is unreliable
    if (isIOS) {
      console.log('[PostMedia] iOS detected - using CSS-only fullscreen toggle');
      setIsFullscreen(!isFullscreen);
      return;
    }

    if (!isFullscreen) {
      // Entering fullscreen - use CSS fallback directly for mobile
      if (isMobile || !container.requestFullscreen) {
        console.log('[PostMedia] Using CSS fallback for mobile/unsupported browser');
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
      if (isMobile) {
        console.log('[PostMedia] Mobile fullscreen exit');
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
    
    // If video is paused, generate a new poster at the seeked position
    if (v.paused && !isPlaying) {
      // Use requestAnimationFrame to ensure the video frame is updated before capturing
      requestAnimationFrame(() => {
        setTimeout(() => {
          generatePausedFramePoster();
          setShowPosterOverlay(true);
        }, 100);
      });
    }
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
    if (isPlaying) {
      scheduleOverlayAutoHide();
    } else {
      // When scrubbing while paused, generate poster at the final position
      const v = videoRef.current;
      if (v && v.paused) {
        requestAnimationFrame(() => {
          setTimeout(() => {
            generatePausedFramePoster();
            setShowPosterOverlay(true);
          }, 100);
        });
      }
    }
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
      <div 
        ref={containerRef}
         className={`w-full md:w-auto max-w-3xl rounded-xl overflow-hidden ring-1 ring-neutral-200 ${
            isFullscreen ? 'fixed inset-0 z-[9999] bg-black flex items-center justify-center rounded-none ring-0 max-w-none' : 'bg-black'
          }`}
        style={isFullscreen ? {
          width: '100vw',
          height: '100vh',
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 9999,
        } : undefined}
      >
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
              poster={effectivePoster || poster}
              onLoadedMetadata={() => {
                const v = videoRef.current;
                const d = v?.duration || 0;
                setDuration(isFinite(d) ? d : 0);
                updateBuffered();
                setVideoReady(true);
                console.log('[PostMedia] Video metadata loaded, duration:', d, 'readyState:', v?.readyState, 'hasEffectivePoster:', Boolean(effectivePoster));
                
                // Ensure poster is shown when video is ready but not playing
                if (!isPlaying && effectivePoster) {
                  setShowPosterOverlay(true);
                }
              }}
              onLoadedData={() => {
                // Video data is loaded, ensure poster shows if not playing
                const v = videoRef.current;
                console.log('[PostMedia] Video data loaded, readyState:', v?.readyState);
                setVideoReady(true);
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
                // Clear paused frame poster when playing
                setPausedFramePoster((prev) => {
                  if (prev) URL.revokeObjectURL(prev);
                  return null;
                });
                scheduleOverlayAutoHide(1200);
              }}
              onPause={() => {
                console.log('[PostMedia] Video paused');
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
                // Clear paused frame and show original poster
                setPausedFramePoster((prev) => {
                  if (prev) URL.revokeObjectURL(prev);
                  return null;
                });
                setShowPosterOverlay(Boolean(effectivePoster));
                setCurrentTime(0);
              }}
              className={`w-full md:w-auto bg-black object-contain ${
                isFullscreen 
                  ? 'h-full max-h-screen max-w-full' 
                  : 'h-auto max-h-[50vh] sm:max-h-[60vh] md:max-h-[65vh] lg:max-h-[70vh]'
              }`}
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
                  style={{ display: 'block' }}
                  onLoad={() => {
                    console.log('[PostMedia] ✓ Poster overlay image loaded and visible:', effectivePoster.substring(0, 50));
                  }}
                  onError={(e) => {
                    console.error('[PostMedia] ✗ Poster overlay image failed to load:', effectivePoster.substring(0, 50));
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

            {/* Fullscreen button */}
            <div className="absolute top-3 right-3 z-10">
              <button
                type="button"
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                onClick={(e) => {
                  e.stopPropagation();
                  handleFullscreen();
                }}
                onTouchStart={(e) => {
                  e.stopPropagation();
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleFullscreen();
                }}
                className={`w-8 h-8 rounded-md bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 hover:bg-black/75 active:bg-black/80 flex items-center justify-center touch-manipulation transition-opacity ${
                  overlayVisible || !isPlaying ? "opacity-100" : "opacity-0"
                }`}
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
) : (
  <div className="relative group">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img
      src={src}
      alt="post media"
      loading="lazy"
      decoding="async"
      sizes="(max-width: 768px) 100vw, 768px"
      className={`block mx-auto select-none ${
        isFullscreen
          ? 'max-h-screen max-w-full object-contain'
          : 'w-full md:w-auto h-auto object-contain max-h-[70vh] md:max-h-[65vh] lg:max-h-[60vh]'
      }`}
      style={{
        imageOrientation: 'from-image' as any, // helps Safari respect EXIF orientation
        touchAction: 'manipulation',
        backgroundColor: 'black',
      }}
      onClick={(e) => {
        e.stopPropagation();
        handleFullscreen();
      }}
    />

    {/* Fullscreen button (images) */}
    <button
      type="button"
      aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      onClick={(e) => {
        e.stopPropagation();
        handleFullscreen();
      }}
      className="absolute top-3 right-3 w-8 h-8 rounded-md bg-black/60 text-white backdrop-blur-sm shadow ring-1 ring-white/20 hover:bg-black/75 active:bg-black/80 flex items-center justify-center"
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
  const [uploadPct, setUploadPct] = useState<number>(0);
  const [uploading, setUploading] = useState<boolean>(false);
  const uploadAbortRef = useRef<AbortController | null>(null);
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

      console.log("[Feed] Feed products found:", subscribed);

      const allProducts = [...prods, ...subscribed];
      if (allProducts.length) {
        const arrays = await Promise.all(allProducts.map(p => fetchApi<{ posts: Post[] }>(`/api/posts/product/${p.id}`, { method: "GET", token, cache: "no-store" })
          .then(r => {
            const posts = r.posts || [];
            // Log poster info for debugging
            posts.forEach(post => {
              console.log(`[Feed] Post ${post.id}:`, {
                media_path: post.media_path,
                media_poster: post.media_poster,
                has_poster: Boolean(post.media_poster)
              });
            });
            return posts.map(post => ({ ...post }));
          })
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
    setError(null);

    try {
      let media_path: string | null | undefined = undefined; // undefined = leave as-is

      // If user picked a replacement file, upload first
      if (draftFile) {
        setUploading(true);
        setUploadPct(0);
        uploadAbortRef.current = new AbortController();

        media_path = await presignAndUploadToS3({
          apiBase,
          token,
          file: draftFile,
          onProgress: (pct) => setUploadPct(pct),
          signal: uploadAbortRef.current.signal,
        });
      } else if (mediaRemoved && !draftMediaPreview) {
        // Explicitly remove media
        media_path = null;
      }

      const body: any = {
        title: draftTitle.trim(),
        body: draftBody.trim(),
      };
      if (media_path !== undefined) {
        body.media_path = media_path;
        if (media_path === null) body.media_remove = "1";
      }

      const updateRes = await fetch(`${apiBase}/api/posts/${editingPost.id}`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!updateRes.ok) {
        const t = await updateRes.text().catch(() => "");
        throw new Error(t || `Update failed (${updateRes.status})`);
      }

      const updated = await updateRes.json(); // { post }
      setPosts((prev) => prev.map((p) => (p.id === editingPost.id ? updated.post : p)));

      setUploading(false);
      setUploadPct(0);
      uploadAbortRef.current = null;
      closeEdit();
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e?.message || "Failed to update post");
      setUploading(false);
    }
  };


  const saveAdd = async () => {
    if (!addingProduct) return;
    setAddingSaving(true);
    setError(null);

    try {
      let media_path: string | null = null;

      // If a file is chosen, upload it first (direct to S3 with progress)
      if (draftFile) {
        setUploading(true);
        setUploadPct(0);
        uploadAbortRef.current = new AbortController();

        media_path = await presignAndUploadToS3({
          apiBase,
          token,
          file: draftFile,
          onProgress: (pct) => setUploadPct(pct),
          signal: uploadAbortRef.current.signal,
        });
      }

      // Create the post with JSON (tiny payload)
      const createRes = await fetch(`${apiBase}/api/posts`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          product_id: String(addingProduct.id),
          title: draftTitle.trim() || null,
          body: draftBody.trim() || null,
          ...(media_path ? { media_path } : {}),
        }),
      });

      if (!createRes.ok) {
        const t = await createRes.text().catch(() => "");
        throw new Error(t || `Create failed (${createRes.status})`);
      }

      const { post } = await createRes.json();
      if (post) setPosts((prev) => [post, ...prev]);

      // reset UI
      setUploading(false);
      setUploadPct(0);
      uploadAbortRef.current = null;
      closeAdd();
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e?.message || "Failed to create post.");
      setUploading(false);
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
                      <div className="relative h-[50px] w-[50px] rounded-full overflow-hidden bg-neutral-200 ring-1 ring-black/5 shrink-0">
                        <Image
                          src={resolveImageUrl(post.profile_image, apiBase) || "/default-avatar.png"}
                          alt="Profile"
                          fill
                          sizes="50px"
                          className="object-cover object-center"
                          quality={92}
                          priority={false}
                        />
                      </div>
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
          <div role="dialog" aria-modal="true" className="relative z-50 w-full max-w-md rounded-2xl bg-white shadow-xl border p-5 animate-in fade-in zoom-in max-h-[85svh] md:max-h-[85vh] overflow-y-auto overscroll-contain">
            <h2 className="text-sm font-semibold mb-3">New post for {addingProduct.title || `Product #${addingProduct.id}`}</h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-1">Title</label>
                <input value={draftTitle} onChange={e => setDraftTitle(e.target.value)} placeholder="Post title" className="w-full rounded-md border px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-1">Body</label>
                <textarea value={draftBody} onChange={e => setDraftBody(e.target.value)} placeholder="Write something..." rows={5} className="w-full rounded-md border px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
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
              {/* Upload progress (ADD THIS) */}
                  {uploading && (
                    <div className="mt-2">
                      <div className="text-xs mb-1 text-neutral-600">Uploading… {uploadPct}%</div>
                      <div className="h-2 w-full bg-neutral-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 transition-all"
                          style={{ width: `${uploadPct}%` }}
                        />
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          className="px-2 py-1 text-[10px] rounded-md border hover:bg-neutral-100"
                          onClick={() => {
                            uploadAbortRef.current?.abort();
                            setUploading(false);
                            setUploadPct(0);
                          }}
                        >
                          Cancel upload
                        </button>
                        <span className="text-[11px] text-neutral-500">
                          We’ll create the post when the upload finishes.
                        </span>
                      </div>
                    </div>
                  )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={closeAdd} className="cursor-pointer px-3 h-8 rounded-md text-xs border hover:bg-neutral-100">Cancel</button>
              <button
                onClick={saveAdd}
                className="cursor-pointer px-3 h-8 rounded-md text-xs bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                disabled={addingSaving || uploading || (!draftTitle.trim() && !draftBody.trim() && !draftMediaPreview)}
              >
                {addingSaving ? "Creating..." : uploading ? `Uploading ${uploadPct}%…` : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {isCreator && editingPost && (
        <div className="fixed inset-0 z-40 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closeEdit} />
          <div role="dialog" aria-modal="true" className="relative z-50 w-full max-w-md rounded-2xl bg-white shadow-xl border p-5 animate-in fade-in zoom-in max-h-[85svh] md:max-h-[85vh] overflow-y-auto overscroll-contain">
            <h2 className="text-sm font-semibold mb-3">Edit Post</h2>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-1">Title</label>
                <input value={draftTitle} onChange={e => setDraftTitle(e.target.value)} placeholder="Post title" className="w-full rounded-md border px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-xs font-medium text-neutral-600 block mb-1">Body</label>
                <textarea value={draftBody} onChange={e => setDraftBody(e.target.value)} placeholder="Write something..." rows={5} className="w-full rounded-md border px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
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
              {/* Upload progress (ADD THIS) */}
              {uploading && (
                <div className="mt-2">
                  <div className="text-xs mb-1 text-neutral-600">Uploading… {uploadPct}%</div>
                  <div className="h-2 w-full bg-neutral-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 transition-all"
                      style={{ width: `${uploadPct}%` }}
                    />
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      className="px-2 py-1 text-[10px] rounded-md border hover:bg-neutral-100"
                      onClick={() => {
                        uploadAbortRef.current?.abort();
                        setUploading(false);
                        setUploadPct(0);
                      }}
                    >
                      Cancel upload
                    </button>
                    <span className="text-[11px] text-neutral-500">
                      We’ll create the post when the upload finishes.
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button onClick={closeEdit} className="px-3 h-8 rounded-md text-xs border hover:bg-neutral-100">Cancel</button>
              <button
                onClick={saveEdit}
                className="px-3 h-8 rounded-md text-xs bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                disabled={uploading || (!draftTitle.trim() && !draftBody.trim() && !draftMediaPreview)}
              >
                {uploading ? `Uploading ${uploadPct}%…` : "Save"}
              </button>
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