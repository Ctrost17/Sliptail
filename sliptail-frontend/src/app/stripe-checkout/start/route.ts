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
 *
 * Behavior:
 * - POST directly to backend to create a Stripe session (forwarding cookies).
 *   - If backend returns 401/403 ⇒ redirect to login (with ?next back here).
 *   - If backend returns { url } ⇒ 303 redirect to Stripe Checkout.
 *   - Else ⇒ redirect back to product page with an error message.
 */
export async function GET(req: NextRequest) {
  const { searchParams, pathname } = new URL(req.url);
  const pid = searchParams.get("pid");
  const action = (searchParams.get("action") || "").toLowerCase();

  if (!pid) {
    return NextResponse.redirect(abs(req, "/"), { status: 302 });
  }

  // Build payload once
  const payload = JSON.stringify({
    product_id: pid,                   // expected by your backend
    productId: pid,                    // leniency for any older handlers
    action: action || undefined,       // optional echo
    mode: action === "membership" ? "subscription" : "payment",
    quantity: 1,
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

      const maybeUrl =
        isRecord(data) ? getString(data, "url") : null;

      const msg =
        (isRecord(data) && (getString(data, "message") || getString(data, "error"))) ||
        (typeof data === "string" ? data : "") ||
        res.statusText;

      if (res.ok && maybeUrl) {
        // Support absolute or relative (rare) URLs
        const absolute =
          /^https?:\/\//i.test(maybeUrl)
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
  const fallback = `/products/${encodeURIComponent(pid)}?error=${encodeURIComponent(
    lastMsg || "Could not start checkout"
  )}`;
  return NextResponse.redirect(abs(req, fallback), { status: 302 });
}
