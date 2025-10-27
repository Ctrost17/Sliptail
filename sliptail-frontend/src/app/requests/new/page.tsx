// app/requests/new/page.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { API_BASE } from "@/lib/api";
import { loadAuth } from "@/lib/auth";
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

  // presigned-upload state
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadPhase, setUploadPhase] = useState<"uploading" | "finalizing" | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedKey, setUploadedKey] = useState<string | null>(null);
  const [uploadedCT, setUploadedCT] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

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
        .then((m) => m.setFlash({ kind: "success", title: toastMsg, ts: Date.now() } as any))
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

  // ---- Direct-to-S3 helpers ----
  async function presignForRequest(theFile: File): Promise<{ key: string; url: string; contentType: string }> {
    const res = await fetch(`${API_BASE}/api/uploads/presign-request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        filename: theFile.name,
        contentType: theFile.type || "application/octet-stream",
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Failed to presign upload (${res.status}) ${t}`);
    }
    return res.json();
  }

  function xhrPutWithProgress(url: string, theFile: File, contentType: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url, true);
      xhr.setRequestHeader("Content-Type", contentType || "application/octet-stream");
      
      // Add authentication for local storage uploads
      const { token } = loadAuth();
      if (token && url.includes(API_BASE)) {
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      }
      
      xhr.withCredentials = true; // Include cookies for CORS
      
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.max(0, Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
        setUploadPct(pct);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        reject(new Error(`S3 upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.send(theFile);
    });
  }

  async function ensureUploadedIfAny(): Promise<{ key: string; contentType: string } | null> {
    if (!file) return null;                 // no file – nothing to upload
    if (uploadedKey) return { key: uploadedKey, contentType: uploadedCT || "application/octet-stream" };           // already uploaded in this session

    setUploadError(null);
    setUploadPhase("uploading");
    setUploadPct(0);

    console.log("[Upload] Starting file upload...", { fileName: file.name, fileSize: file.size });
    
    try {
      const { key, url, contentType } = await presignForRequest(file);
      console.log("[Upload] Got presigned URL", { key, url: url.substring(0, 50) + '...' });
      
      await xhrPutWithProgress(url, file, contentType);
      console.log("[Upload] Upload completed successfully", { key });
      
      setUploadedKey(key);
      setUploadedCT(contentType);
      setUploadPct(100);
      
      return { key, contentType };
    } catch (err) {
      console.error("[Upload] Upload failed:", err);
      throw err; // Re-throw to be caught by handleSubmit
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submittingRef.current) return;

    setSubmitting(true);
    submittingRef.current = true;
    setUploadError(null);
    setUploadPct(null);
    setUploadPhase(null);

    try {
      // 1) Upload directly to S3 if a file is selected
      let uploadResult: { key: string; contentType: string } | null = null;
      if (file) {
        uploadResult = await ensureUploadedIfAny();
        console.log("[Submit] Upload result:", uploadResult);
      }

        // 2) Create the request via JSON (no multipart)
        setUploadPhase("finalizing");

        const hasSession = !!sessionId;
        const hasOrder = !!orderId;

        let url: string;
        let payload: Record<string, any>;

        if (hasSession) {
          url = `${API_BASE}/api/requests/create-from-session`;
          payload = {
            session_id: sessionId,
            message: details || "",
          };
        } else if (hasOrder) {
          url = `${API_BASE}/api/requests`; // <-- legacy route that takes orderId
          payload = {
            orderId,                       // REQUIRED by this route
            details: details || "",        // or message
          };
        } else {
          // If you ever support the pure create route here, you MUST also provide:
          // { creator_id, product_id, message }
          throw new Error("Missing session_id or orderId for request creation");
        }

        // Use the upload result directly instead of state (avoids race condition)
        if (uploadResult) {
          payload.attachment_key = uploadResult.key;
          payload.attachment_content_type = uploadResult.contentType;
          console.log("[Submit] Including attachment in request", { attachment_key: uploadResult.key, attachment_content_type: uploadResult.contentType });
        } else if (file) {
          console.warn("[Submit] File was selected but uploadResult is null!", { file: file.name });
        }

        console.log("[Submit] Sending request", { url, payload });

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
          credentials: "include",
        });

      if (res.status === 401 || res.status === 403) {
        // route to login preserving query
        const params = new URLSearchParams();
        if (orderId) params.set("orderId", String(orderId));
        if (sessionId) params.set("session_id", sessionId);
        const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
        router.replace(`/auth/login?next=${encodeURIComponent(nextUrl)}`);
        return;
      }

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        let msg = `Failed to create request (${res.status})`;
        try {
          const j = JSON.parse(t || "{}");
          msg = j?.error || j?.message || msg;
        } catch {}
        throw new Error(msg);
      }

      // 3) Success → toast on purchases page
      redirectToPurchases("Your request has been submitted!");
    } catch (e: any) {
      const msg = e?.message || "Could not submit your request.";
      error(msg);
      setUploadError(msg);
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
      // keep the bar if there was an error; otherwise reset shortly
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
    // reset any previous upload state if they pick a new file
    setUploadedKey(null);
    setUploadedCT(null);
    setUploadPct(null);
    setUploadPhase(null);
    setUploadError(null);
  }

  function doLater() {
    // NO toast here (per your preference)
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
