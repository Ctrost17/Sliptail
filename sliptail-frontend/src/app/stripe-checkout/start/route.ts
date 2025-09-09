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
 * - If NOT signed in ⇒ 302 to /auth/login?next=<this exact URL>
 * - If signed in     ⇒ POST to backend to create a Stripe session (try several routes),
 *                      then 303 to Stripe
 */
export async function GET(req: NextRequest) {
  const { searchParams, pathname } = new URL(req.url);
  const pid = searchParams.get("pid");
  const action = (searchParams.get("action") || "").toLowerCase();

  if (!pid) {
    return NextResponse.redirect(abs(req, "/"), { status: 302 });
  }

  // 1) Check auth by forwarding cookies to backend
  const meRes = await fetch(`${API_BASE}/api/auth/me`, {
    headers: { cookie: req.headers.get("cookie") || "" },
    cache: "no-store",
  });

  if (meRes.status === 401 || meRes.status === 403) {
    const nextUrl = `${pathname}?${searchParams.toString()}`;
    const loginUrl = `/auth/login?next=${encodeURIComponent(nextUrl)}`;
    return NextResponse.redirect(abs(req, loginUrl), { status: 302 });
  }

  // 2) Create Stripe Session — try your stripe-checkout endpoints first
  const payload = JSON.stringify({
    product_id: pid,         // most backends accept this
    productId: pid,          // leniency
    action: action || undefined, // optional
    mode: action === "membership" ? "subscription" : "payment",
    quantity: 1,
  });

  const commonHeaders = {
    "Content-Type": "application/json",
    cookie: req.headers.get("cookie") || "",
  };

  const candidates = [
    // Your declared router first
    `${API_BASE}/api/stripe-checkout/start`,
    `${API_BASE}/api/stripe-checkout/session`,
    `${API_BASE}/api/stripe-checkout/create-session`,
    `${API_BASE}/api/stripe-checkout/create`,
    // Fallbacks (in case your backend exposes older paths)
    `${API_BASE}/api/checkout/start`,
    `${API_BASE}/api/checkout/session`,
    `${API_BASE}/api/checkout/create-session`,
    `${API_BASE}/api/checkout/create`,
    `${API_BASE}/api/stripe/checkout/session`,
    `${API_BASE}/api/stripe/checkout/create-session`,
  ];

  let stripeUrl: string | null = null;
  let lastMsg = "";

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: commonHeaders,
        body: payload,
        cache: "no-store",
      });

      const ct = res.headers.get("content-type") || "";
      const data: Json | string | null = ct.includes("application/json")
        ? ((await res.json().catch(() => ({}))) as Json)
        : await res.text().catch(() => "");

      const maybeUrl = isRecord(data) ? getString(data, "url") : null;
      const msg =
        (isRecord(data) && (getString(data, "message") || getString(data, "error"))) ||
        (typeof data === "string" ? data : "") ||
        res.statusText;

      if (res.ok && maybeUrl) {
        stripeUrl = maybeUrl;
        break;
      } else {
        lastMsg = `(${res.status}) ${msg || "Unknown error"}`;
      }
    } catch {
      // try next candidate
    }
  }

  if (stripeUrl) {
    // If backend returns a relative path (unlikely for Stripe, but safe):
    const absolute =
      /^https?:\/\//i.test(stripeUrl)
        ? stripeUrl
        : `${API_BASE}${stripeUrl.startsWith("/") ? "" : "/"}${stripeUrl}`;
    return NextResponse.redirect(absolute, { status: 303 });
  }

  // 3) Fallback if backend failed to create session — include readable reason
  const fallback = `/products/${encodeURIComponent(pid)}?error=${encodeURIComponent(
    lastMsg || "Could not start checkout"
  )}`;
  return NextResponse.redirect(abs(req, fallback), { status: 302 });
}
