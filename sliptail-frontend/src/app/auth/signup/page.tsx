"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";

export default function SignupPage() {
  const { signup, loading } = useAuth();
  const search = useSearchParams();
  const next = search.get("next") || "/";

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await signup(email.trim(), password, username.trim() || undefined);
      setDone(true);
      // If you return a verify_session from backend, you could:
      // localStorage.setItem("verify_session", verifySession);
      // localStorage.setItem("pendingVerifyEmail", email.trim());
      // router.replace("/auth/check-email");
    } catch (e: unknown) {
      if (e && typeof e === "object" && "message" in e && typeof (e as { message?: unknown }).message === "string") {
        setErr((e as { message: string }).message);
      } else {
        setErr("Signup failed");
      }
    }
  };

  function googleAuth() {
    const qs = next ? `?next=${encodeURIComponent(next)}` : "";
    // Backend route must exist: /api/auth/google/start (with callback configured)
    window.location.href = `/api/auth/google/start${qs}`;
  }

  if (done) {
    return (
      <main className="p-6 max-w-md mx-auto">
        <h1 className="text-xl font-semibold mb-2">Check your email</h1>
        <p>We sent you a verification link to complete sign up.</p>
        <p className="mt-3 text-sm">
          Already verified?{" "}
          <Link className="underline" href={`/auth/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}>
            Log in
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="p-6 max-w-md mx-auto space-y-4">
      <h1 className="text-xl font-semibold">Sign up</h1>

      <form onSubmit={submit} className="space-y-3">
        <input
          className="w-full border rounded px-3 py-2"
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e)=>setEmail(e.target.value)}
        />
        <input
          className="w-full border rounded px-3 py-2"
          placeholder="Username (optional)"
          value={username}
          onChange={(e)=>setUsername(e.target.value)}
        />
        <input
          className="w-full border rounded px-3 py-2"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e)=>setPassword(e.target.value)}
        />
        {err && <p className="text-red-600 text-sm">{err}</p>}
        <button
          disabled={loading}
          className="w-full px-4 py-2 rounded bg-black text-white disabled:opacity-50"
        >
          {loading ? "…" : "Create account"}
        </button>
      </form>

      <div className="flex items-center justify-center gap-3 text-xs text-neutral-500">
        <span className="flex-1 h-px bg-neutral-200" />
        or
        <span className="flex-1 h-px bg-neutral-200" />
      </div>

      <button
        onClick={googleAuth}
        className="w-full rounded border py-2 text-sm"
        aria-label="Continue with Google"
      >
        Continue with Google
      </button>

      <p className="mt-3 text-sm">
        Already have an account?{" "}
        <Link className="underline" href={`/auth/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}>
          Log in
        </Link>
      </p>
    </main>
  );
}
