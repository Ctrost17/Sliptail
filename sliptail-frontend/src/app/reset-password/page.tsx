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
  reset_kind?: "guest" | "forgot";
  auto_login?: boolean;
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

      if (!json?.success) {
        throw new Error(json?.error || json?.message || "Reset failed");
      }

      // Backend tells us what kind of reset this is
      const resetKind = json.reset_kind;
      const autoLogin = !!json.auto_login;

      // Guest buyer: backend set cookie + auto_verify, so send them home
      if (resetKind === "guest" && autoLogin) {
        router.push("/");
        return;
      }

      // Normal forgot-password user:
      // show success message briefly, then send to login
      setDone(true);
      setTimeout(() => router.push("/auth/login"), 1500);
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
      <h1 className="mb-3 text-2xl font-semibold">Reset Password</h1>
      {done ? (
        <>
          <p className="mb-4">Your password has been updated.</p>
          <Link href="/auth/login" className="underline">
            Go to login
          </Link>
        </>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <input
            type="password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            placeholder="New password"
            className="w-full rounded px-3 py-2 border"
          />
          {err && <p className="text-red-600">{err}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="rounded px-4 py-2 border"
          >
            {submitting ? "Saving…" : "Set new password"}
          </button>
        </form>
      )}
    </main>
  );
}