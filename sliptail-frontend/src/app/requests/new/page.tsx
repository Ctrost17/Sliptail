// app/requests/new/page.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { API_BASE } from "@/lib/api";
import { useAuth } from "@/components/auth/AuthProvider";

// Replace with your real toast system/hook
function useToast() {
  return {
    success: (msg: string) => console.log("[TOAST SUCCESS]", msg),
    error: (msg: string) => console.error("[TOAST ERROR]", msg),
  };
}

type CreateRequestOk = { ok: true; requestId: number };
type CreateRequestErr = { ok: false; error: string };
type CreateRequestResponse = CreateRequestOk | CreateRequestErr;


export default function NewRequestPage() {
  const search = useSearchParams();
  const router = useRouter();
  const { success, error } = useToast();
  const { token } = useAuth();

  const orderId = useMemo(() => {
    const raw = search.get("orderId");
    const num = raw ? Number(raw) : NaN;
    return Number.isFinite(num) ? num : 0;
  }, [search]);

  const sid = search.get("sid");

  const initialToast = search.get("toast");

  const [details, setDetails] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const submittingRef = useRef(false);

  // If a toast was passed via query (legacy), show it once via console placeholder
  useEffect(() => {
    if (initialToast && initialToast.trim()) success(initialToast);
  }, [initialToast, success]);

  // If no orderId but we have a Stripe session id, we can still create the request from session
  if (!orderId && !sid) {
    return (
      <div className="mx-auto max-w-xl p-8">
        <h1 className="text-xl font-semibold">Invalid request</h1>
        <p className="mt-2 text-neutral-600">We couldn’t find your order.</p>
        <button
          onClick={() => router.replace("/purchases")}
          className="mt-4 rounded border px-4 py-2"
        >
          Go to Purchases
        </button>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submittingRef.current) return;
    setSubmitting(true);
    submittingRef.current = true;
    try {
      const formData = new FormData();
      const headers: Record<string, string> = { Accept: "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      // Prefer session-based creation when sid is present, even if orderId is provided
      let url = `${API_BASE}/api/requests`;

      if (sid) {
        url = `${API_BASE}/api/requests/create-from-session`;
        formData.append("session_id", String(sid));
        formData.append("message", details);
        if (file) formData.append("attachment", file);
      } else if (orderId) {
        formData.append("orderId", String(orderId));
        formData.append("details", details);
        if (file) formData.append("attachment", file);
      }

      let res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: formData,
      });

      if (res.status === 401 || res.status === 403) {
        const params = new URLSearchParams();
        if (orderId) params.set("orderId", String(orderId));
        if (sid) params.set("sid", String(sid));
        const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
        router.replace(`/auth/login?next=${encodeURIComponent(nextUrl)}`);
        return;
      }

      let payload: any = await res.json().catch(() => ({}));

      if (!res.ok) {
        // If we tried create-from-session (sid present), only fallback on server errors (5xx).
        // For client errors (4xx), surface the specific message instead of masking with 'Failed'.
        const isCreateFromSession = Boolean(sid);
        const isServerError = res.status >= 500;
        if (isCreateFromSession && isServerError && orderId) {
          const fd2 = new FormData();
          fd2.append("orderId", String(orderId));
          fd2.append("details", details);
          if (file) fd2.append("attachment", file);
          res = await fetch(`${API_BASE}/api/requests`, {
            method: "POST",
            credentials: "include",
            headers,
            body: fd2,
          });
          payload = await res.json().catch(() => ({}));
        }
        if (!res.ok) {
          const message = payload?.error || `${res.status} ${res.statusText}`;
          throw new Error(message);
        }
      }

      // Support both legacy and new shapes
      const newOk = payload && payload.success === true;
      const legacyOk = payload && payload.ok === true;
      if (!newOk && !legacyOk) {
        const message = payload?.error || "Request failed";
        throw new Error(message);
      }

      const toastMsg = initialToast && initialToast.includes("Thanks for Supporting")
        ? initialToast
        : "Thanks for Supporting Your Creator";
      try {
        const { setFlash } = await import("@/lib/flash");
        setFlash({ kind: "success", title: toastMsg, ts: Date.now() });
      } catch { }
      router.replace(`/purchases`);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Could not submit your request.";
      error(message);
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  }

  function handleFileChange(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.currentTarget.files?.[0] ?? null;
    setFile(f);
  }

  function doLater() {
    const toastMsg = initialToast && initialToast.includes("Thanks for Supporting")
      ? initialToast
      : "Thanks for Supporting Your Creator";
    import("@/lib/flash").then(m => m.setFlash({ kind: "success", title: toastMsg, ts: Date.now() })).catch(() => { });
    router.replace(`/purchases`);
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
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
          <input
            type="file"
            accept="image/*,video/*,application/pdf"
            onChange={handleFileChange}
            className="block"
          />
          {file && (
            <span className="text-xs text-neutral-600">
              Selected: {file.name}
            </span>
          )}
        </label>

        <div className="mt-4 flex gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-green-600 px-5 py-2 font-semibold text-white disabled:opacity-60"
          >
            {submitting ? "Submitting…" : "Submit Request"}
          </button>
          <button
            type="button"
            onClick={doLater}
            className="rounded border px-5 py-2 font-semibold"
          >
            Do Later
          </button>
        </div>
      </form>
    </div>
  );
}