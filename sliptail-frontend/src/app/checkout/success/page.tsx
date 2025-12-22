// src/app/checkout/success/page.tsx
"use client";

import Link from "next/link";
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

const SUPPORT_EMAIL = "info@sliptail.com";

function CheckIcon() {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 ring-1 ring-emerald-200">
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6 text-emerald-700"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M20 6L9 17l-5-5"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function Step({
  n,
  title,
  desc,
}: {
  n: number;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black text-xs font-bold text-white">
        {n}
      </div>
      <div>
        <div className="text-sm font-semibold text-neutral-900">{title}</div>
        <div className="mt-0.5 text-sm text-neutral-600">{desc}</div>
      </div>
    </div>
  );
}

export default function CheckoutSuccessPage() {
  const search = useSearchParams();
  const router = useRouter();

  const { user, token, loading } = useAuth();
  const finalizingRef = useRef(false);

  const sessionId = (search.get("sid") ||
    search.get("session_id") ||
    search.get("sessionId") ||
    "") as string;

  const acct = useMemo(() => search.get("acct"), [search]);
  const pid = useMemo(() => search.get("pid"), [search]);
  const done = useMemo(() => search.get("done") === "1", [search]);
  const isFreeSession = useMemo(
    () => (sessionId || "").startsWith("free_"),
    [sessionId]
  );

  // guest = no user once loading has finished
  const isGuest = !loading && !user;

  const nextUrl = useMemo(() => {
    if (typeof window === "undefined") return "/checkout/success";
    return `${window.location.pathname}${window.location.search}`;
  }, []);

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

    // Guest buyers:
    // If this is a request purchase, send them to /requests/new to add details/attachment,
    // then back here with ?done=1 to show the confirmation UI.
    if (isGuest) {
      if (done) return;

      async function routeGuestIfRequest() {
        try {
          if (!pid) return;

          const res = await fetch(
            `${API_BASE}/api/products/${encodeURIComponent(pid)}`,
            { headers: { Accept: "application/json" } }
          );
          if (!res.ok) return;

          const product = await res.json();
          const pType = String(product?.product_type || "").toLowerCase();
          if (pType !== "request") return;

          const returnTo = `/checkout/success?sid=${encodeURIComponent(
            sessionId
          )}&pid=${encodeURIComponent(pid)}&done=1`;

          router.replace(
            `/requests/new?sid=${encodeURIComponent(
              sessionId
            )}&pid=${encodeURIComponent(pid)}&returnTo=${encodeURIComponent(
              returnTo
            )}`
          );
        } catch {
          // If anything fails, just show success UI.
        }
      }

      void routeGuestIfRequest();
      return;
    }

    async function finalize() {
      if (finalizingRef.current) return;
      finalizingRef.current = true;

      try {
        const headers: Record<string, string> = { Accept: "application/json" };
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
          router.replace(`/auth/login?next=${encodeURIComponent(nextUrl)}`);
          return;
        }

        const payload = (await res.json()) as FinalizeResponse;

        if (!payload.ok) {
          try {
            setFlash({
              kind: "error",
              title:
                payload.error || "Something went wrong finalizing your order.",
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

        const next =
          payload.type === "request"
            ? `/requests/new?orderId=${payload.orderId}&sid=${sidParam}&${toastParam}`
            : `/purchases?${toastParam}`;

        router.replace(next);
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

    void finalize();
  }, [sessionId, acct, pid, done, router, loading, isGuest, token, nextUrl]);

  const supportMailto = useMemo(() => {
    const subject = "Help with my Sliptail order";
    const body = `Hi Sliptail Support,%0D%0A%0D%0AI need help with my order.%0D%0A%0D%0AStripe session id: ${
      sessionId || "(not available)"
    }%0D%0A%0D%0AThanks!`;
    return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
      subject
    )}&body=${body}`;
  }, [sessionId]);

  const loginHref = `/auth/login?next=${encodeURIComponent(nextUrl)}`;

  const title = !sessionId
    ? "Something went wrong"
    : isGuest
    ? "Order confirmed"
    : "Finishing up...";

  const subtitle = !sessionId
    ? "We could not find your checkout session."
    : isGuest
    ? "You are all set. Follow the steps below to access your order."
    : isFreeSession
    ? "Unlocking your access..."
    : "Confirming your purchase with Stripe.";

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      {isGuest ? (
        <div className="rounded-2xl border border-neutral-200 bg-white shadow-sm">
          {/* Header */}
          <div className="flex items-start gap-4 border-b border-neutral-100 p-6">
            <CheckIcon />
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-neutral-900">{title}</h1>
              <p className="mt-1 text-sm text-neutral-600">{subtitle}</p>

              <div className="mt-3 rounded-xl bg-neutral-50 p-3 text-sm text-neutral-700">
                We sent an email to the address you typed during Stripe checkout.
                <span className="ml-2 text-neutral-500">
                  Use that email to set a password and access your order.
                </span>
              </div>
            </div>
          </div>

          {/* Steps */}
          <div className="p-6">
            <div className="mb-4 text-sm font-semibold text-neutral-900">
              What to do next
            </div>

            <div className="space-y-4">
              <Step
                n={1}
                title="Open your email"
                desc="Click the link in the email we sent you to set a password for your Sliptail profile."
              />
              <div className="flex gap-3">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black text-xs font-bold text-white">
                  2
                </div>
                <div>
                  <div className="text-sm font-semibold text-neutral-900">Log in to access your order</div>
                  <div className="mt-0.5 text-sm text-neutral-600">
                    After setting your password, you can log in anytime to access your downloads or track request updates on your <span className="font-bold">My Purchases</span> page.
                  </div>
                </div>
              </div>
              <Step
                n={3}
                title="Already have a Sliptail account?"
                desc="If you already have an account with that same email, this order will appear under that account automatically."
              />
            </div>

            {/* Buttons */}
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link
                href={loginHref}
                className="inline-flex w-full items-center justify-center rounded-xl bg-black px-4 py-3 text-sm font-semibold text-white hover:bg-neutral-800 sm:w-auto"
              >
                Log in
              </Link>

              <a
                href={supportMailto}
                className="inline-flex w-full items-center justify-center rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-100 sm:w-auto"
              >
                Email support
              </a>
            </div>

            {/* Help box */}
            <div className="mt-5 rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
              <div className="font-semibold text-neutral-900">
                Did not get the email?
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-neutral-600">
                <li>Check Spam or Promotions.</li>
                <li>Make sure you used the correct email during checkout.</li>
                <li>
                  Still stuck? Email{" "}
                  <a className="font-semibold text-neutral-900" href={supportMailto}>
                    {SUPPORT_EMAIL}
                  </a>
                  .
                </li>
              </ul>
            </div>
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-xl rounded-2xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold text-neutral-900">{title}</h1>
          <p className="mt-2 text-neutral-600">{subtitle}</p>
          {!isGuest && (
            <div className="mt-6 h-2 w-40 mx-auto animate-pulse rounded bg-emerald-500/40" />
          )}
        </div>
      )}
    </main>
  );
}