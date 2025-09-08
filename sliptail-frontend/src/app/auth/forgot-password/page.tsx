"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

export default function ForgotPasswordPage() {
  const search = useSearchParams();
  const prefill = search.get("email") || "";

  const [email, setEmail] = useState(prefill);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (prefill) setEmail(prefill);
  }, [prefill]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSent(false);
    setLoading(true);
    try {
      // Adjust the endpoint to match your backend.
      const res = await fetch("/api/auth/password/reset/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim() }),
      });

      // For security, don’t reveal whether the email exists.
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (text) console.warn("reset/start:", text);
      }

      setSent(true);
    } catch (_err) {
      // `_err` name avoids eslint unused-var warning
      console.error("Forgot password error:", _err);
      setErr("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm px-4 py-10 space-y-4">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      <p className="text-sm text-neutral-600">
        Enter the email associated with your account and we will send you a link
        to reset your password.
      </p>

      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label
            htmlFor="reset-email"
            className="block text-xs font-medium text-neutral-700"
          >
            Email
          </label>
          <input
            id="reset-email"
            type="email"
            className="mt-1 w-full rounded-xl border px-3 py-2"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>

        {err && <div className="text-sm text-red-600">{err}</div>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-black py-2 text-white disabled:opacity-50"
        >
          {loading ? "Sending…" : "Send reset email"}
        </button>
      </form>

      {sent && (
        <div className="rounded-xl border p-3 text-sm text-neutral-700">
          If an account exists for <strong>{email}</strong>, we’ve sent a reset
          link. Please check your inbox.
        </div>
      )}
    </main>
  );
}
