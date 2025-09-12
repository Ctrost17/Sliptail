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
        const res = await fetch(
          `${API_BASE}/api/stripe-checkout/finalize?session_id=${encodeURIComponent(sessionId)}`,
          { credentials: "include", headers, signal: ac.signal }
        );
        if (res.status === 401 || res.status === 403) {
          // Not authenticated — send to login and come back here
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

        // Use flash-based toast so green check appears globally after redirect
        try { setFlash({ kind: "success", title: msg, ts: Date.now() });
         } catch {}

        if (payload.type === "request") {
          const sidParam = encodeURIComponent(sessionId);
          router.replace(`/requests/new?orderId=${payload.orderId}&sid=${sidParam}`);
        } else {
          router.replace(`/purchases`);
        }
      } catch (e: unknown) {
        console.error("Finalize error:", e);
        try { setFlash({ kind: "error", title: "Could not finalize your order.", ts: Date.now() }); } catch {}
        router.replace("/purchases");
      } finally {
        finalizingRef.current = false;
      }
    }

    // Wait for auth hydration before finalizing; if cookies work, token may be null but request will still succeed
    if (!loading && !finalizingRef.current) {
      void finalize();
    }
  }, [sessionId, router, token, loading]);
  return (
    <div className="mx-auto max-w-xl p-8 text-center">
      <h1 className="text-2xl font-semibold">Finishing up…</h1>
      <p className="mt-2 text-neutral-600">
        Confirming your purchase with Stripe.
      </p>
      <div className="mt-6 h-2 w-40 mx-auto animate-pulse rounded bg-green-500/40" />
    </div>
  );
}
