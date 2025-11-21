"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiPost } from "@/lib/api";
import { isAxiosError } from "axios";

type ResetResponse = {
  success?: boolean;
  message?: string;
  error?: string;
  auto_verified?: boolean;
};

export default function ResetPasswordPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const token = sp.get("token") ?? "";
  const [pwd, setPwd] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [done, setDone] = useState<boolean>(false);
  const [err, setErr] = useState<string>("");
  const [autoVerified, setAutoVerified] = useState<boolean>(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");

    if (!token) {
      setErr("Missing token");
      return;
    }
    if (pwd.length < 8) {
      setErr("Password must be at least 8 characters");
      return;
    }

    setSubmitting(true);
    try {
      // Uses Axios instance with baseURL `${API_BASE}/api` and withCredentials=true
      const json = await apiPost<ResetResponse>("/auth/reset", {
        token,
        password: pwd,
      });

      if (json?.success) {
        const isAutoVerified = !!json.auto_verified;
        setAutoVerified(isAutoVerified);
        setDone(true);

        // Guest buyer who just claimed their account:
        // - backend already set auth cookie
        // - send them to home
        if (isAutoVerified) {
          setTimeout(() => router.push("/"), 1500);
        } else {
          // Normal forgot-password user:
          // keep them logged out, send to login
          setTimeout(() => router.push("/auth/login"), 1500);
        }
      } else {
        throw new Error(json?.error || json?.message || "Reset failed");
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
          {autoVerified ? (
            <>
              <p className="mb-4">
                Your password has been set and your account is ready. Redirecting you to your account...
              </p>
              <Link href="/" className="underline">
                Go to homepage
              </Link>
            </>
          ) : (
            <>
              <p className="mb-4">
                Your password has been updated. You can now sign in with your new password.
              </p>
              <Link href="/auth/login" className="underline">
                Sign in
              </Link>
            </>
          )}
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
            className="border rounded px-4 py-2"
          >
            {submitting ? "Saving…" : "Set new password"}
          </button>
        </form>
      )}
    </main>
  );
}