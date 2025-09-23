"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function OAuthCompletePage() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") || "/";

  const [err, setErr] = useState<string | null>(null);

  const tokenFromHash = useMemo(() => {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash || "";
    const m = hash.match(/token=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }, []);

  useEffect(() => {
    if (!tokenFromHash) {
      setErr("Missing token from login response.");
      return;
    }

    try {
      localStorage.setItem("token", tokenFromHash);
      try {
        window.dispatchEvent(new CustomEvent("auth:token", { detail: { action: "set" } }));
      } catch { /* ignore */ }
      if (typeof window !== "undefined") {
        window.location.replace(next);
      } else {
        router.replace(next);
      }
    } catch {
      setErr("Unable to store session. Please try again.");
    }
  }, [router, next, tokenFromHash]);

  if (err) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="mb-2 text-xl font-semibold">Google sign-in</h1>
        <p className="text-red-600">{err}</p>
        <button
          className="mt-4 rounded-lg border px-3 py-1"
          onClick={() => router.replace("/auth/login")}
        >
          Back to login
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="mb-2 text-xl font-semibold">Google sign-in</h1>
      <p className="text-gray-600">Finishing up…</p>
    </main>
  );
}