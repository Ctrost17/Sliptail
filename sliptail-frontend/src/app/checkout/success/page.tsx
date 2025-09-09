"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/** Minimal shapes returned by your APIs (only what we read). */
interface ProductMin {
  user_id?: number;
}
interface CreatorProfileMin {
  display_name?: string | null;
}
interface CreatorRespMin {
  profile?: CreatorProfileMin | null;
}

/** Safer error -> message extractor */
function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return "Unknown error";
  }
}

const API_BASE = (
  process.env.NEXT_PUBLIC_API_URL || process.env.API_BASE_URL || "http://localhost:5000"
).replace(/\/$/, "");

/** Optional: tiny flash util so /purchases can show a toast if desired */
function setFlash(kind: "success" | "error" | "info", title: string, message?: string) {
  if (typeof window === "undefined") return;
  const payload = { kind, title, message, ts: Date.now() };
  localStorage.setItem("sliptail_flash", JSON.stringify(payload));
}

export default function CheckoutSuccessPage() {
  const router = useRouter();
  const sp = useSearchParams();

  const sid = sp.get("sid") || sp.get("session_id"); // Stripe CHECKOUT_SESSION_ID
  const pid = sp.get("pid"); // product id
  const action = (sp.get("action") || "").toLowerCase(); // purchase | membership | request

  const [creatorName, setCreatorName] = useState<string | null>(null);
  const [loadingMeta, setLoadingMeta] = useState<boolean>(!!pid);
  const [openRequestForm, setOpenRequestForm] = useState<boolean>(false);

  const [message, setMessage] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitMsg, setSubmitMsg] = useState<string>("");

  // Refs for “Next” flow on request
  const formWrapRef = useRef<HTMLDivElement | null>(null);
  const messageRef = useRef<HTMLTextAreaElement | null>(null);

  // Load creator display name for the thank-you line
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pid) return;
      try {
        // Product -> get creator id
        const prodRes = await fetch(`${API_BASE}/api/products/${encodeURIComponent(pid)}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!prodRes.ok) throw new Error(await prodRes.text());
        const prod = (await prodRes.json()) as ProductMin;
        const creatorId = typeof prod.user_id === "number" ? prod.user_id : null;

        if (creatorId) {
          // Creator -> get profile.display_name
          const creatorRes = await fetch(`${API_BASE}/api/creators/${creatorId}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (creatorRes.ok) {
            const data = (await creatorRes.json()) as CreatorRespMin;
            const dn = data?.profile?.display_name ?? null;
            if (!cancelled) setCreatorName(dn);
          }
        }
      } catch {
        /* non-fatal */
      } finally {
        if (!cancelled) setLoadingMeta(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pid]);

  // Purchases & memberships: go straight to /purchases (no waiting)
  useEffect(() => {
    if (action && action !== "request") {
      setFlash("success", "Purchase Successful", `Thanks for supporting ${creatorName || "the creator"}!`);
      // Use replace so browser Back doesn't bounce through success page
      router.replace("/purchases");
    }
  }, [action, creatorName, router]);

  // For requests, show the inline form
  useEffect(() => {
    if (action === "request") setOpenRequestForm(true);
  }, [action]);

  // “Next” button -> open form, scroll, focus message box
  function goToRequestForm() {
    setOpenRequestForm(true);
    requestAnimationFrame(() => {
      formWrapRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => messageRef.current?.focus(), 250);
    });
  }

  async function submitRequestForm() {
    if (!sid) return;
    setSubmitting(true);
    setSubmitMsg("");
    try {
      const fd = new FormData();
      fd.append("session_id", sid);
      if (message) fd.append("message", message);
      if (file) fd.append("attachment", file);

      const res = await fetch(`${API_BASE}/api/requests/create-from-session`, {
        method: "POST",
        body: fd,
        credentials: "include",
        cache: "no-store",
      });

      if (!res.ok) {
        const ct = res.headers.get("content-type") || "";
        const txt = ct.includes("application/json")
          ? JSON.stringify(await res.json()).slice(0, 300)
          : await res.text();
        throw new Error(txt || res.statusText);
      }

      // You wanted requests to go to My Purchases:
      setSubmitMsg("Request submitted! Taking you to My Purchases…");

      // Optional: toast on /purchases as well for requests
      setFlash("success", "Purchase Successful", `Thanks for supporting ${creatorName || "the creator"}!`);

      setTimeout(() => router.push("/purchases"), 1200);
    } catch (e: unknown) {
      setSubmitMsg(`Failed: ${getErrorMessage(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <div className="flex items-start gap-3 rounded-2xl border p-4">
        <div className="mt-1 text-2xl">✅</div>
        <div>
          <div className="text-lg font-semibold">Purchase Successful</div>
          <div className="text-neutral-700">
            Thanks for supporting{loadingMeta ? "…" : ` ${creatorName || "the creator"}`}!
          </div>

          {action === "request" ? (
            <div className="mt-3 flex items-center gap-3">
              <button
                className="rounded-xl bg-black px-4 py-2 text-white"
                onClick={goToRequestForm}
                aria-controls="request-form"
              >
                Next: Fill Out Request
              </button>
              <button
                className="rounded-xl border px-4 py-2"
                onClick={() => router.push("/purchases")}
              >
                Do this later
              </button>
            </div>
          ) : (
            // For purchases/memberships we immediately redirect; this is just a tiny fallback
            <div className="mt-3 text-sm text-neutral-600">
              Redirecting to <span className="font-medium">My Purchases</span>…
              <button className="ml-2 underline" onClick={() => router.replace("/purchases")}>
                Go now
              </button>
            </div>
          )}
        </div>
      </div>

      {openRequestForm ? (
        <section ref={formWrapRef} id="request-form" className="mt-6">
          <div className="rounded-2xl border p-4">
            <h2 className="text-lg font-semibold mb-2">Tell the creator what you need</h2>
            <p className="text-sm text-neutral-700 mb-3">Add details and an optional attachment.</p>

            <div className="space-y-3">
              <textarea
                ref={messageRef}
                className="w-full rounded-xl border p-2"
                rows={6}
                placeholder="Describe your request…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-neutral-700"
              />
              <div className="flex gap-2">
                <button
                  className="rounded-xl bg-black px-4 py-2 text-white disabled:opacity-60"
                  onClick={() => void submitRequestForm()}
                  disabled={submitting}
                >
                  {submitting ? "Submitting…" : "Submit request"}
                </button>
                <button
                  className="rounded-xl border px-4 py-2"
                  onClick={() => router.push("/purchases")}
                  disabled={submitting}
                >
                  Skip for now
                </button>
              </div>
              {submitMsg ? <div className="text-sm text-neutral-700">{submitMsg}</div> : null}
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
