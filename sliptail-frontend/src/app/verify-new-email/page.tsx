"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { API_BASE } from "@/lib/api";

export default function VerifyEmailPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const token = sp.get("token") ?? "";
  const [state, setState] = useState<"idle" | "ok" | "error">("idle");
  const [msg, setMsg] = useState<string>("");

  useEffect(() => {
    if (!token) {
      setState("error");
      setMsg("Missing token");
      return;
    }

    let aborted = false;

    (async () => {
      try {
        // Use manual redirect so CORS on the frontend redirect doesn't break the request
        const res = await fetch(
          `${API_BASE}/api/auth/verify?token=${encodeURIComponent(token)}`,
          {
            method: "GET",
            credentials: "include",
            redirect: "manual",
            headers: { Accept: "application/json" },
          }
        );

        if (aborted) return;

        // Treat opaqueredirect or any 2xx/3xx as success (the backend 302s to /auth/verified)
        const looksSuccessful =
          res.ok ||
          res.type === "opaqueredirect" ||
          (res.status >= 300 && res.status < 400);

        if (looksSuccessful) {
          setState("ok");
          setMsg("Email verified!");
        } else {
          let t = "";
          try {
            t = await res.text();
          } catch {
            /* ignore */
          }
          setState("error");
          setMsg(t || "Verification failed");
        }
      } catch (err: unknown) {
        if (aborted) return;
        const message = err instanceof Error ? err.message : "Verification failed";
        setState("error");
        setMsg(message);
      }
    })();

    return () => {
      aborted = true;
    };
  }, [token]);

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-2xl font-semibold mb-3">Verify New Email</h1>

      {state === "idle" && <p>Verifying…</p>}

      {state === "ok" && (
        <>
          <p className="mb-4">Hi, your email has been verified. 🎉</p>
          <Link href="/auth/verified" className="underline">
            Continue
          </Link>
        </>
      )}

      {state === "error" && (
        <>
          <p className="mb-4 text-red-600">Oops: {msg}</p>
          <button className="underline" onClick={() => router.replace("/login")}>
            Go to login
          </button>
        </>
      )}
    </main>
  );
}
