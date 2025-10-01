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

  const initialToast = search.get("toast");

  const [details, setDetails] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (initialToast && initialToast.trim()) success(initialToast);
  }, [initialToast, success]);

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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submittingRef.current) return;
    setSubmitting(true);
    submittingRef.current = true;

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

      let res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: formData,
        signal: ac.signal,
      });

      if (res.status === 401 || res.status === 403) {
        const params = new URLSearchParams();
        if (orderId) params.set("orderId", String(orderId));
        if (sessionId) params.set("session_id", sessionId);
        const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
        router.replace(`/auth/login?next=${encodeURIComponent(nextUrl)}`);
        return;
      }

      if (!res.ok && useSessionFlow && res.status >= 500 && orderId) {
        const fd2 = new FormData();
        fd2.append("orderId", String(orderId));
        fd2.append("details", details || "");
        if (file) fd2.append("attachment", file);
        res = await fetch(`${API_BASE}/api/requests`, {
          method: "POST",
          credentials: "include",
          headers,
          body: fd2,
          signal: ac.signal,
        });
      }

      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const text = await res.text();
          if (text) {
            try {
              const j = JSON.parse(text);
              msg = j?.error || j?.message || text;
            } catch {
              msg = text;
            }
          }
        } catch {}
        throw new Error(msg);
      }

      const toastMsg =
        initialToast && initialToast.includes("Thanks for Supporting")
          ? initialToast
          : "Your request was submitted";
      redirectToPurchases(toastMsg);
    } catch (e: any) {
      if (e?.name === "AbortError") {
        error("Request timed out. Please try again.");
      } else {
        const msg = e instanceof Error ? e.message : "Could not submit your request.";
        error(msg);
      }
    } finally {
      clearTimeout(t);
      setSubmitting(false);
      submittingRef.current = false;
    }
  }

  function handleFileChange(ev: React.ChangeEvent<HTMLInputElement>) {
    setFile(ev.currentTarget.files?.[0] ?? null);
  }

  function doLater() {
    const toastMsg =
      initialToast && initialToast.includes("Thanks for Supporting")
        ? initialToast
        : "Thanks for Supporting Your Creator";
    import("@/lib/flash")
      .then((m) => m.setFlash({ kind: "success", title: toastMsg, ts: Date.now() }))
      .catch(() => {});
    router.replace(`/purchases`);
    setTimeout(() => {
      if (window.location.pathname.includes("/requests/new")) {
        window.location.href = "/purchases";
      }
    }, 150);
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

          {/* Hidden native file input */}
          <input
            id="attachment"
            type="file"
            accept="image/*,video/*,application/pdf"
            onChange={handleFileChange}
            className="hidden"
          />

          {/* Button + filename text */}
          <div className="flex items-center gap-3">
            <label
              htmlFor="attachment"
              className="cursor-pointer inline-flex items-center rounded-xl border bg-black px-4 py-2 text-sm font-medium text-white"
            >
              Choose File
            </label>

            <span className="text-sm text-neutral-600 truncate">
              {file ? file.name : "No file selected"}
            </span>
          </div>
        </label>

        <div className="mt-4 flex gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="cursor-pointer rounded bg-green-600 px-5 py-2 font-semibold text-white disabled:opacity-60"
          >
            {submitting ? "Submitting…" : "Submit Request"}
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
