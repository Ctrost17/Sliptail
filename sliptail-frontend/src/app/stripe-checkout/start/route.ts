// src/app/stripe-checkout/start/route.ts
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic"; // avoid caching in app router

function abs(req: NextRequest, path: string) {
  return new URL(path, req.url).toString();
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
  process.env.API_BASE_URL?.replace(/\/$/, "") ||
  "http://localhost:5000";

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function getString(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Usage:
 *   /stripe-checkout/start?pid=<productId>&action=purchase|membership|request
 */
export async function GET(req: NextRequest) {
  const { searchParams, pathname } = new URL(req.url);
  const pid = searchParams.get("pid");
  const actionRaw = (searchParams.get("action") || "").toLowerCase();
  const action = actionRaw || "purchase"; // treat missing as a purchase

  if (!pid) {
    return NextResponse.redirect(abs(req, "/"), { status: 302 });
  }

  // Build success/cancel URLs:
  // - Requests go to /checkout/success (so we can collect details)
  // - Purchases/Memberships go straight to /purchases (optionally with a toast flag)
  const origin = new URL(req.url).origin;

  const successUrl =
    action === "request"
      ? `${origin}/checkout/success?sid={CHECKOUT_SESSION_ID}&pid=${encodeURIComponent(
          pid
        )}&action=${encodeURIComponent(action)}`
      : `${origin}/purchases?flash=purchase_success&session_id={CHECKOUT_SESSION_ID}&pid=${encodeURIComponent(
          pid
        )}&action=${encodeURIComponent(action)}`;

  const cancelUrl = `${origin}/checkout/cancel?pid=${encodeURIComponent(
    pid
  )}&action=${encodeURIComponent(action)}`;

  // Build payload once
  const payload = JSON.stringify({
    product_id: pid, // expected by your backend
    productId: pid, // leniency for any older handlers
    action: action || undefined, // optional echo
    mode: action === "membership" ? "subscription" : "payment",
    quantity: 1,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  // Forward cookies so cookie-based auth works server-to-server
  const headers = {
    "content-type": "application/json",
    cookie: req.headers.get("cookie") || "",
  };

  // Try your current route first, then fallbacks
  const endpoints = [
    `${API_BASE}/api/stripe-checkout/create-session`, // your implemented route
    `${API_BASE}/api/stripe-checkout/session`,
    `${API_BASE}/api/stripe-checkout/create`,
    `${API_BASE}/api/checkout/create-session`,
    `${API_BASE}/api/checkout/session`,
    `${API_BASE}/api/checkout/create`,
    `${API_BASE}/api/stripe/checkout/session`,
    `${API_BASE}/api/stripe/checkout/create-session`,
  ];

  let lastMsg = "";

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        cache: "no-store",
      });

      // If not authenticated, send to login with next back to this URL
      if (res.status === 401 || res.status === 403) {
        const nextUrl = `${pathname}?${searchParams.toString()}`;
        const loginUrl = `/auth/login?next=${encodeURIComponent(nextUrl)}`;
        return NextResponse.redirect(abs(req, loginUrl), { status: 302 });
      }

      const ct = res.headers.get("content-type") || "";
      const data: Json | string | null = ct.includes("application/json")
        ? ((await res.json().catch(() => ({}))) as Json)
        : await res.text().catch(() => "");

      const maybeUrl = isRecord(data) ? getString(data, "url") : null;
      const errorCode = isRecord(data) ? getString(data, "error") : undefined;

      const msg =
        (isRecord(data) &&
          (getString(data, "message") || getString(data, "error"))) ||
        (typeof data === "string" ? data : "") ||
        res.statusText;

      // 🔴 Special case: creator's payouts not ready
      if (errorCode === "creator_not_ready") {
        const unavailableUrl = `/checkout/unavailable?pid=${encodeURIComponent(
          pid
        )}&reason=creator_not_ready`;
        return NextResponse.redirect(abs(req, unavailableUrl), {
          status: 302,
        });
      }

      if (res.ok && maybeUrl) {
        // Support absolute or relative (rare) URLs
        const absolute = /^https?:\/\//i.test(maybeUrl)
          ? maybeUrl
          : `${API_BASE}${maybeUrl.startsWith("/") ? "" : "/"}${maybeUrl}`;
        return NextResponse.redirect(absolute, { status: 303 });
      } else {
        lastMsg = `(${res.status}) ${msg || "Unknown error"}`;
      }
    } catch {
      // try next endpoint
    }
  }

  // Fallback — send back to product page with the last error we saw
  const fallback = `/products/${encodeURIComponent(
    pid
  )}?error=${encodeURIComponent(lastMsg || "Could not start checkout")}`;
  return NextResponse.redirect(abs(req, fallback), { status: 302 });
}
