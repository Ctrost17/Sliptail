// app/checkout/success/page.tsx
"use client";

import { useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// Replace this with your actual toast system
function useToast() {
  return {
    success: (msg: string) => console.log("[TOAST SUCCESS]", msg),
    error: (msg: string) => console.error("[TOAST ERROR]", msg),
  };
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

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
  const { success, error } = useToast();
  const sessionId = useMemo(
    () => search.get("session_id") || search.get("sessionId"),
    [search]
  );

  useEffect(() => {
    async function finalize() {
      if (!sessionId) {
        error("Missing Stripe session id.");
        router.replace("/purchases");
        return;
      }

      try {
        const res = await fetch(
          `${API_BASE}/api/checkout/finalize?session_id=${encodeURIComponent(
            sessionId
          )}`,
          { credentials: "include" }
        );
        const payload: FinalizeResponse = await res.json();

        if (!payload.ok) {
          error(payload.error || "Something went wrong finalizing your order.");
          router.replace("/purchases");
          return;
        }

        const msg =
          payload.type === "request"
            ? `Thanks for Supporting ${payload.creatorDisplayName}`
            : `Purchase Successful, Thanks for Supporting ${payload.creatorDisplayName}`;

        if (payload.type === "request") {
          router.replace(
            `/requests/new?orderId=${payload.orderId}&toast=${encodeURIComponent(
              msg
            )}`
          );
        } else {
          router.replace(`/purchases?toast=${encodeURIComponent(msg)}`);
        }
      } catch (e: unknown) {
      console.error("Finalize error:", e);
      error("Could not finalize your order.");
     router.replace("/purchases");
      }
    }

    finalize();
  }, [sessionId, router, error, success]);

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
