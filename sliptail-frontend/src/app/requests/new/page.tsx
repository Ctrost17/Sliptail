// app/requests/new/page.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { API_BASE } from "@/lib/api";
import { useAuth } from "@/components/auth/AuthProvider";

function useToast() {
  return {
    success: (msg: string) => console.log("[TOAST SUCCESS]", msg),
    error: (msg: string) => console.error("[TOAST ERROR]", msg),
  };
}

/** --- tiny preview component (image | video | audio) --- */
function AttachmentPreview({
  file,
  url,
}: {
  file: File | null;
  url: string | null;
}) {
  const [ratio, setRatio] = useState<number | null>(null);
  if (!file || !url) return null;

  const mime = file.type || "";
  const name = file.name.toLowerCase();

  const isVideo =
    mime.startsWith("video/") ||
    /\.(mp4|webm|ogg|m4v|mov)$/i.test(name.split("?")[0]);
  const isAudio =
    mime.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|webm)$/i.test(name);
  const isImage =
    mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg)$/i.test(name);

  const handleVideoMeta = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const el = e.currentTarget;
    if (el.videoWidth && el.videoHeight) setRatio(el.videoWidth / el.videoHeight);
  };
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const el = e.currentTarget;
    if (el.naturalWidth && el.naturalHeight)
      setRatio(el.naturalWidth / el.naturalHeight);
  };

  return (
      <div
        className="relative mt-3 mx-auto w-full max-w-[22rem] sm:max-w-[36rem] md:max-w-full rounded-xl overflow-hidden ring-1 ring-neutral-200 max-h-[70vh]"
        style={ratio ? { aspectRatio: String(ratio) } : undefined}
      >
      {isAudio ? (
        <audio
          src={url}
          controls
          preload="metadata"
          className="block w-full max-w-full bg-black"
        />
      ) : isVideo ? (
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          controlsList="nodownload"
          className="block w-full h-full object-contain bg-black"
          onLoadedMetadata={handleVideoMeta}
        />
      ) : isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt="attachment preview"
          loading="lazy"
          className="block w-full h-full object-contain bg-black"
          onLoad={handleImageLoad}
        />
      ) : (
        <div className="flex items-center gap-2 p-3 text-sm text-white/90">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-white/10">📎</span>
          <span className="truncate">{file.name}</span>
        </div>
      )}
    </div>
  );
}

export default function NewRequestPage() {
  const search = useSearchParams();
  const router = useRouter();
  const { success, error } = useToast();
  const { token } = useAuth();

  const orderId = useMemo(() => {
    const raw = search.get("orderId") || search.get("order_id") || "";
    const num = raw ? Number(raw) : NaN;
    return Number.isFinite(num) ? num : 0;
  }, [search]);

  // Accept session_id, sessionId, or sid
  const sessionId = useMemo(
    () =>
      (search.get("session_id") ||
        search.get("sessionId") ||
        search.get("sid") ||
        ""
      ).trim(),
    [search]
  );

  const [details, setDetails] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadPhase, setUploadPhase] = useState<"uploading" | "finalizing" | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // cleanup object URL when file changes/unmounts
  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (!orderId && !sessionId) {
    return (
      <div className="mx-auto max-w-xl p-8">
        <h1 className="text-xl font-semibold">Invalid request</h1>
        <p className="mt-2 text-neutral-600">We couldn’t find your order.</p>
        <button onClick={() => router.replace("/purchases")} className="mt-4 rounded border px-4 py-2">
          Go to Purchases
        </button>
      </div>
    );
  }

  function redirectToPurchases(toastMsg: string) {
    try {
      import("@/lib/flash")
        .then((m) => m.setFlash({ kind: "success", title: toastMsg, ts: Date.now() }))
        .catch(() => {});
    } catch {}
    const url = `/purchases?toast=${encodeURIComponent(toastMsg)}`;
    router.replace(url);
    setTimeout(() => {
      if (window.location.pathname.includes("/requests/new")) {
        window.location.href = url;
      }
    }, 150);
  }

  function postFormWithProgress(opts: {
    url: string;
    formData: FormData;
    headers?: Record<string, string>;
    withCredentials?: boolean;
    onProgress?: (pct: number) => void;
  }): Promise<{ ok: boolean; status: number; statusText: string; body: string }> {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", opts.url, true);

      if (opts.withCredentials) xhr.withCredentials = true;
      if (opts.headers) {
        for (const [k, v] of Object.entries(opts.headers)) xhr.setRequestHeader(k, v);
      }

      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.max(0, Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
        opts.onProgress?.(pct);
      };

      xhr.onreadystatechange = () => {
        if (xhr.readyState === 4) {
          resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            statusText: xhr.statusText,
            body: xhr.responseText || "",
          });
        }
      };

      xhr.send(opts.formData);
    });
  }


  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submittingRef.current) return;

    setSubmitting(true);
    submittingRef.current = true;
    setUploadError(null);
    setUploadPct(0);
    setUploadPhase("uploading");

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20000);

    try {
      const formData = new FormData();
      const useSessionFlow = Boolean(sessionId);
      let url = `${API_BASE}/api/requests`;

      if (useSessionFlow) {
        url = `${API_BASE}/api/requests/create-from-session`;
        formData.append("session_id", sessionId);
        formData.append("message", details || "");
      } else {
        formData.append("orderId", String(orderId));
        formData.append("details", details || "");
      }
      if (file) formData.append("attachment", file);

      const headers: Record<string, string> = { Accept: "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      // First try main request
      let res = await postFormWithProgress({
        url,
        formData,
        headers,
        withCredentials: true,
        onProgress: (pct) => setUploadPct(pct),
      });

      // Auth redirect if needed
      if ((res.status === 401 || res.status === 403)) {
        const params = new URLSearchParams();
        if (orderId) params.set("orderId", String(orderId));
        if (sessionId) params.set("session_id", sessionId);
        const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
        router.replace(`/auth/login?next=${encodeURIComponent(nextUrl)}`);
        return;
      }

      // Fallback to orderId flow if session flow failed with 5xx
      if (!res.ok && useSessionFlow && res.status >= 500 && orderId) {
        const fd2 = new FormData();
        fd2.append("orderId", String(orderId));
        fd2.append("details", details || "");
        if (file) fd2.append("attachment", file);

        setUploadPct(0);
        setUploadPhase("uploading");
        res = await postFormWithProgress({
          url: `${API_BASE}/api/requests`,
          formData: fd2,
          headers,
          withCredentials: true,
          onProgress: (pct) => setUploadPct(pct),
        });
      }

      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const j = JSON.parse(res.body || "{}");
          msg = j?.error || j?.message || msg;
        } catch {
          if (res.body) msg = res.body;
        }
        throw new Error(msg);
      }

      setUploadPhase("finalizing");
      redirectToPurchases("Your request has been submitted!");

    } catch (e: any) {
      if (e?.name === "AbortError") {
        error("Request timed out. Please try again.");
        setUploadError("Timed out");
      } else {
        const msg = e instanceof Error ? e.message : "Could not submit your request.";
        error(msg);
        setUploadError(msg);
      }
    } finally {
      clearTimeout(t);
      setSubmitting(false);
      submittingRef.current = false;
      // leave the bar visible if there's an error; otherwise reset after a short delay
      if (!uploadError) {
        setTimeout(() => {
          setUploadPct(null);
          setUploadPhase(null);
        }, 600);
      }
    }
  }

  function handleFileChange(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.currentTarget.files?.[0] ?? null;
    // revoke old preview first
    if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(f ? URL.createObjectURL(f) : null);
  }

  function doLater() {
    router.replace("/purchases");
    setTimeout(() => {
      if (window.location.pathname.includes("/requests/new")) {
        window.location.href = "/purchases";
      }
    }, 150);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-6">
      <h1 className="mb-2 text-2xl font-bold">Tell the creator what you need</h1>
      <p className="mb-6 text-neutral-600">
        Add a brief description and any reference media (optional). You can also
        do this later.
      </p>

      <form onSubmit={handleSubmit} className="grid gap-4">
        <label className="grid gap-2">
          <span className="text-sm font-medium">Description</span>
          <textarea
            className="min-h-[120px] w-full rounded border p-3"
            value={details}
            onChange={(ev) => setDetails(ev.target.value)}
            placeholder="Describe your request…"
            required
          />
        </label>

        <label className="grid gap-2">
          <span className="text-sm font-medium">Attachment (optional)</span>

          {/* Hidden native file input */}
          <input
            id="attachment"
            name="attachment"
            type="file"
            className="hidden"
            onChange={handleFileChange}
            // ← allow audio (MP3, WAV, M4A, OGG, etc.) plus common docs
            accept="
              image/*,
              video/*,
              audio/*,
              .mp3,.wav,.m4a,.aac,.ogg,.webm,
              .pdf,.epub,.txt,.csv,.xlsx,.xls,.svg
            "
          />

          {/* Button + filename text */}
          <div className="flex items-center gap-3">
            <label
              htmlFor="attachment"
              className="cursor-pointer inline-flex items-center rounded-xl border bg-black px-4 py-2 text-sm font-medium text-white"
            >
              Choose File
            </label>

            {/* Make the text shrink inside the row instead of pushing layout wide */}
            <div className="min-w-0 flex-1">
              <span className="block text-xs sm:text-sm text-neutral-600
                 max-w-full break-words break-all leading-snug">
                {file ? file.name : "No file selected"}
              </span>
            </div>
          </div>

          {/* Inline media preview (image / video / audio) */}
          <AttachmentPreview file={file} url={previewUrl} />
        </label>
        {(uploadPhase || uploadPct !== null || uploadError) && (
          <div className="mt-2 space-y-2">
            {uploadPhase && (
              <div className="text-xs text-neutral-600">
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
        <div className="mt-4 flex gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="cursor-pointer rounded bg-green-600 px-5 py-2 font-semibold text-white disabled:opacity-60"
          >
            {submitting
              ? uploadPhase === "finalizing"
                ? "Finalizing…"
                : uploadPct !== null
                  ? `Uploading ${uploadPct}%…`
                  : "Submitting…"
              : "Submit Request"}
          </button>
          <button
            type="button"
            onClick={doLater}
            className="cursor-pointer rounded border px-5 py-2 font-semibold"
          >
            Do Later
          </button>
        </div>
      </form>
    </div>
  );
}
