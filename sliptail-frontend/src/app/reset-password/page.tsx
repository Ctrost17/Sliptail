"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiPost, apiGet } from "@/lib/api";
import { isAxiosError } from "axios";

type ResetResponse = {
  success?: boolean;
  message?: string;
  error?: string;
};

export default function ResetPasswordPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const token = sp.get("token") ?? "";

  const [pwd, setPwd] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [done, setDone] = useState<boolean>(false);
  const [err, setErr] = useState<string>("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");

    if (!token) {
      setErr("Missing or invalid reset link.");
      return;
    }
    if (pwd.length < 8) {
      setErr("Password must be at least 8 characters");
      return;
    }

    setSubmitting(true);
    try {
      // 1) Call backend to reset password
      const json = await apiPost<ResetResponse>("/auth/reset", {
        token,
        password: pwd,
      });

      if (!json?.success) {
        throw new Error(json?.error || json?.message || "Reset failed");
      }

      // 2) Check if the user is now logged in via cookie
      //    For guest-buyer tokens, your backend sets a login cookie.
      let isNowLoggedIn = false;
      try {
        const me = await apiGet<{ user?: unknown }>("/auth/me");
        if (me && me.user) {
          isNowLoggedIn = true;
        }
      } catch {
        // 401/403 just means they are *not* logged in (normal forgot-password flow)
        isNowLoggedIn = false;
      }

      if (isNowLoggedIn) {
        // Guest buyer flow:
        // Backend has logged them in via cookie → do a HARD redirect
        // so the entire app (Navbar/AuthProvider) sees the new auth state.
        if (typeof window !== "undefined") {
          window.location.href = "/";
          return;
        }
      } else {
        // Normal forgot-password flow:
        // Show success message and keep them logged out.
        setDone(true);
        // After a short pause, send them to the login page
        setTimeout(() => {
          router.push("/auth/login");
        }, 1500);
      }
    } catch (e: unknown) {
      if (isAxiosError(e)) {
        const data = e.response?.data as Partial<ResetResponse> | undefined;
        const msg =
          (typeof data?.error === "string" && data.error) ||
          (typeof data?.message === "string" && data.message) ||
          e.message;
        setErr(msg ?? "Reset failed");
      } else {
        setErr(e instanceof Error ? e.message : "Reset failed");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-2xl font-semibold mb-3">Reset Password</h1>

      {done ? (
        <>
          <p className="mb-4">Your password has been updated.</p>
          <Link href="/auth/login" className="underline">
            Go to sign in
          </Link>
        </>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <input
            type="password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            placeholder="New password"
            className="w-full border rounded px-3 py-2"
          />
          {err && <p className="text-red-600">{err}</p>}
          <button
            type="submit"
            disabled={submitting}
             className={`border rounded px-4 py-2 ${
                submitting ? "cursor-not-allowed opacity-60" : "cursor-pointer"
              }`}
          >
            {submitting ? "Saving…" : "Set new password"}
          </button>
        </form>
      )}
    </main>
  );
}
