"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function CreatorCompleteSetupPage() {
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get("token");

  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tokenMissing, setTokenMissing] = useState(false);

  useEffect(() => {
    if (!token) {
      setTokenMissing(true);
      setError("Missing invite token. Please use the link from your email.");
    }
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;

    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (password !== password2) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/complete-invite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          token,
          password,
          username: username || undefined,
          displayName: displayName || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setSubmitting(false);
        return;
      }

      // Success: they are now logged in as a creator
      // Adjust this path if your creator dashboard route is different
      router.push("/dashboard");
    } catch (err) {
      console.error(err);
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md rounded-2xl bg-slate-900/80 border border-slate-700 p-8 shadow-xl">
        <h1 className="text-2xl font-semibold text-white mb-2">
          Set up your creator account
        </h1>
        <p className="text-sm text-slate-300 mb-6">
          Choose a password and basic profile info to finish your creator setup.
        </p>

        {error && (
          <div className="mb-4 rounded-lg bg-red-900/40 border border-red-500 px-3 py-2 text-sm text-red-100">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-200 mb-1">
              Display name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
              placeholder="What fans will see (for example Coach Alex)"
              disabled={submitting || tokenMissing}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-200 mb-1">
              Username (optional)
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
              placeholder="yourhandle"
              disabled={submitting || tokenMissing}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-200 mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
              placeholder="••••••••"
              disabled={submitting || tokenMissing}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-200 mb-1">
              Confirm password
            </label>
            <input
              type="password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
              placeholder="••••••••"
              disabled={submitting || tokenMissing}
            />
          </div>

          <button
            type="submit"
            disabled={submitting || tokenMissing}
            className="mt-2 w-full rounded-lg bg-emerald-500 py-2 text-sm font-medium text-slate-950 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? "Completing setup..." : "Complete setup"}
          </button>
        </form>
      </div>
    </div>
  );
}
