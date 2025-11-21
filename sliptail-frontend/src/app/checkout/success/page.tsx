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

  // ⬇️ pull both user and token from auth
  const { user, token, loading } = useAuth();
  const finalizingRef = useRef(false);

  const sessionId = (search.get("sid") ||
    search.get("session_id") ||
    search.get("sessionId") ||
    "") as string;

  const acct = useMemo(() => search.get("acct"), [search]);
  const pid = useMemo(() => search.get("pid"), [search]);
  const isFreeSession = useMemo(
    () => (sessionId || "").startsWith("free_"),
    [sessionId]
  );

  // ⬇️ guest = no user once loading has finished
  const isGuest = !loading && !user;

  useEffect(() => {
    if (loading) return;

    if (!sessionId) {
      try {
        setFlash({
          kind: "error",
          title: "Missing Stripe session id.",
          ts: Date.now(),
        });
      } catch {}
      router.replace("/purchases");
      return;
    }

    // Guest buyers: show the success UI only, let webhooks handle fulfillment
    if (isGuest) {
      return;
    }

    async function finalize() {
      if (finalizingRef.current) return;
      finalizingRef.current = true;

      try {
        const headers: Record<string, string> = { Accept: "application/json" };
        // still send Bearer token when we have one (local dev, etc)
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const q = new URLSearchParams();
        q.set("session_id", sessionId);
        if (acct) q.set("acct", acct);
        if (pid) q.set("pid", pid);

        const res = await fetch(
          `${API_BASE}/api/stripe-checkout/finalize?${q.toString()}`,
          {
            credentials: "include",
            headers,
          }
        );

        if (res.status === 401 || res.status === 403) {
          const nextUrl = `${window.location.pathname}${window.location.search}`;
          router.replace(`/auth/login?next=${encodeURIComponent(nextUrl)}`);
          return;
        }

        const payload = (await res.json()) as FinalizeResponse;

        if (!payload.ok) {
          try {
            setFlash({
              kind: "error",
              title:
                payload.error ||
                "Something went wrong finalizing your order.",
              ts: Date.now(),
            });
          } catch {}
          router.replace("/purchases");
          return;
        }

        const msg =
          payload.type === "request"
            ? `Thanks for supporting ${payload.creatorDisplayName}`
            : `Purchase successful, thanks for supporting ${payload.creatorDisplayName}`;

        try {
          setFlash({
            kind: "success",
            title: msg,
            ts: Date.now(),
          });
        } catch {}

        const sidParam = encodeURIComponent(sessionId);
        const toastParam = `toast=${encodeURIComponent(msg)}`;

        const nextUrl =
          payload.type === "request"
            ? `/requests/new?orderId=${payload.orderId}&sid=${sidParam}&${toastParam}`
            : `/purchases?${toastParam}`;

        router.replace(nextUrl);
      } catch (e) {
        console.error("Finalize error:", e);
        try {
          setFlash({
            kind: "error",
            title: "Could not finalize your order.",
            ts: Date.now(),
          });
        } catch {}
        router.replace("/purchases");
      } finally {
        finalizingRef.current = false;
      }
    }

    if (!finalizingRef.current) {
      void finalize();
    }
  }, [sessionId, acct, pid, router, loading, isGuest, token]);

  const title = !sessionId
    ? "Something went wrong"
    : isGuest
    ? "Order placed"
    : "Finishing up...";

  const subtitle = !sessionId
    ? "We could not find your checkout session."
    : isGuest
    ? "Thanks for your purchase. Check your email for details, and if you already have a Sliptail account with the email used during checkout, you can just log in to see your order. Contact support if you have any questions or issues."
    : isFreeSession
    ? "Unlocking your access..."
    : "Confirming your purchase with Stripe.";

  return (
    <div className="mx-auto max-w-xl p-8 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-neutral-600">{subtitle}</p>
      {!isGuest && (
        <div className="mt-6 h-2 w-40 mx-auto animate-pulse rounded bg-green-500/40" />
      )}
    </div>
  );
}
