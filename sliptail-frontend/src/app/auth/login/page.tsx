"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { mutate } from "swr";
import { useAuth } from "@/components/auth/AuthProvider";
import PasswordField from "@/components/forms/PasswordField";

export default function LoginPage() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") || "/";
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [resent, setResent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      // AuthProvider should store token + user (local)
      await login(email, password);

      // Immediately revalidate Navbar data (server-truth)
      await Promise.allSettled([
        mutate("/api/auth/me"),           // user session
        mutate("/api/me/creator-status"), // creator activation
      ]);

      // Navigate and force a refresh so the header re-renders
      router.replace(next || "/");
      router.refresh();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Login failed";
      if (msg.toLowerCase().includes("verify")) {
        setVerifyOpen(true);
      } else {
        setErr(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    setErr(null);
    setResent(false);
    try {
      await fetch(`/api/auth/verify/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email }),
      });
      setResent(true);
    } catch {
      setResent(false);
    }
  }

  function googleAuth() {
    const qs = next ? `?next=${encodeURIComponent(next)}` : "";
    window.location.href = `/api/auth/google/start${qs}`;
  }

  function goForgotPassword() {
    const emailParam = email ? `?email=${encodeURIComponent(email)}` : "";
    window.location.href = `/auth/forgot-password${emailParam}`;
  }

  return (
    <main className="mx-auto max-w-sm px-4 py-10 space-y-4">
      <h1 className="text-2xl font-bold">Log in</h1>

      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-neutral-700" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="you@example.com"
            className="mt-1 w-full rounded-xl border px-3 py-2"
            autoComplete="email"
            required
          />
        </div>

        <PasswordField
          id="password"
          label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          autoComplete="current-password"
        />

        {err && <div className="text-sm text-red-600">{err}</div>}

        <button disabled={loading} className="w-full rounded-xl bg-black py-2 text-white">
          {loading ? "Signing in…" : "Sign in"}
        </button>

        {/* Forgot password link */}
        <div className="text-sm text-center">
          <button
            type="button"
            onClick={goForgotPassword}
            className="underline"
          >
            Forgot your password?
          </button>
        </div>
      </form>

      <button
        onClick={googleAuth}
        className="w-full rounded-xl border py-2 text-sm"
        aria-label="Continue with Google"
        type="button"
      >
        Continue with Google
      </button>

      <div className="text-sm text-center">
        Don’t have an account{" "}
        <Link
          className="underline"
          href={`/auth/signup${next ? `?next=${encodeURIComponent(next)}` : ""}`}
        >
          Create one
        </Link>
      </div>

      {/* Verify modal */}
      {verifyOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-4 space-y-3">
            <h3 className="text-lg font-semibold">Please verify your email</h3>
            <p className="text-sm text-neutral-700">
              We sent a verification link to <strong>{email}</strong>. Click the link, then try again.
            </p>
            <div className="flex items-center gap-2">
              <button onClick={resend} className="rounded-xl border px-3 py-1 text-sm">
                Resend verification email
              </button>
              {resent && <span className="text-sm text-sky-700">Sent!</span>}
            </div>
            <div className="flex justify-end">
              <button onClick={() => setVerifyOpen(false)} className="rounded-xl border px-3 py-1 text-sm">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
