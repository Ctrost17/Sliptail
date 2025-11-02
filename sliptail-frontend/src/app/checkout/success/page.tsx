// app/checkout/success/page.tsx
"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { API_BASE } from "@/lib/api";
import { setFlash } from "@/lib/flash";

type FinalizeResponse =
  | {
      ok: true;
      type: "purchase" | "membership" | "request";
      creatorDisplayName: string;
      orderId: number;
    }
  | { ok: false; error: string };

export default function CheckoutSuccessPage() {
  const search = useSearchParams();
  const router = useRouter();
  const { token, loading } = useAuth();
  const finalizingRef = useRef(false);
  const sessionId = useMemo(
    () => search.get("sid") || search.get("session_id") || search.get("sessionId"),
    [search]
  );
  const acct = useMemo(() => search.get("acct"), [search]);
  const pid  = useMemo(() => search.get("pid"), [search]);
  const isFreeSession = useMemo(() => (sessionId || "").startsWith("free_"), [sessionId]);

  useEffect(() => {
    async function finalize() {
      if (finalizingRef.current) return;
      if (!sessionId) {
        try { setFlash({ kind: "error", title: "Missing Stripe session id.", ts: Date.now() }); } catch {}
        router.replace("/purchases");
        return;
      }

      finalizingRef.current = true;
      try {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const ac = new AbortController();
        const q = new URLSearchParams();
        q.set("session_id", sessionId);
        if (acct) q.set("acct", acct);
        if (pid)  q.set("pid",  pid);

        const res = await fetch(
          `${API_BASE}/api/stripe-checkout/finalize?${q.toString()}`,
          { credentials: "include", headers, signal: ac.signal }
        );

        if (res.status === 401 || res.status === 403) {
          const nextUrl = `${window.location.pathname}${window.location.search}`;
          router.replace(`/auth/login?next=${encodeURIComponent(nextUrl)}`);
          return;
        }

        const payload: FinalizeResponse = await res.json();

        if (!payload.ok) {
          try { setFlash({ kind: "error", title: payload.error || "Something went wrong finalizing your order.", ts: Date.now() }); } catch {}
          router.replace("/purchases");
          return;
        }

        const msg =
          payload.type === "request"
            ? `Thanks for Supporting ${payload.creatorDisplayName}`
            : `Purchase Successful, Thanks for Supporting ${payload.creatorDisplayName}`;

        // 1) Best-effort global flash (desktop usually fine)
        try { setFlash({ kind: "success", title: msg, ts: Date.now() }); } catch {}

        // 2) iOS-safe delivery via URL param
        const sidParam = encodeURIComponent(sessionId);
        const toastParam = `toast=${encodeURIComponent(msg)}`;

        const nextUrl =
          payload.type === "request"
            ? `/requests/new?orderId=${payload.orderId}&sid=${sidParam}&${toastParam}`
            : `/purchases?${toastParam}`;

        // Give the storage write a micro-tick before navigating (helps some mobile engines)
        setTimeout(() => router.replace(nextUrl), 0);
      } catch (e: unknown) {
        console.error("Finalize error:", e);
        try { setFlash({ kind: "error", title: "Could not finalize your order.", ts: Date.now() }); } catch {}
        router.replace("/purchases");
      } finally {
        finalizingRef.current = false;
      }
    }

    // Wait for auth hydration; proceed even if token is null (cookies may suffice)
    if (!loading && !finalizingRef.current) {
      void finalize();
    }
  }, [sessionId, acct, pid, router, token, loading]);

  return (
    <div className="mx-auto max-w-xl p-8 text-center">
      <h1 className="text-2xl font-semibold">Finishing up…</h1>
      <p className="mt-2 text-neutral-600">
        {isFreeSession ? "Unlocking your access…" : "Confirming your purchase with Stripe."}
      </p>
      <div className="mt-6 h-2 w-40 mx-auto animate-pulse rounded bg-green-500/40" />
    </div>
  );
}
