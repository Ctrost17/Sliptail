"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import PasswordField from "@/components/forms/PasswordField";
import NextImage from "next/image";

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
      // If backend returns a verify session, you can redirect to a "check email" flow here.
    } catch (e: unknown) {
      if (
        e &&
        typeof e === "object" &&
        "message" in e &&
        typeof (e as { message?: unknown }).message === "string"
      ) {
        setErr((e as { message: string }).message);
      } else {
        setErr("Signup failed");
      }
    }
  };

  function googleAuth() {
    const qs = next ? `?next=${encodeURIComponent(next)}` : "";
    window.location.href = `/api/auth/google/start${qs}`;
  }

  if (done) {
    return (
      <main className="p-6 max-w-md mx-auto">
        <h1 className="text-xl font-semibold mb-2">Check your email</h1>
        <p>We sent you a verification link to complete sign up.</p>
        <p className="mt-3 text-sm">
          Already verified?{" "}
          <Link
            className="underline"
            href={`/auth/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}
          >
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
        <div>
          <label htmlFor="signup-email" className="block text-xs font-medium text-neutral-700">
            Email
          </label>
          <input
            id="signup-email"
            className="mt-1 w-full border rounded px-3 py-2"
            placeholder="you@example.com"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>

        <div>
          <label htmlFor="signup-username" className="block text-xs font-medium text-neutral-700">
            Username (optional)
          </label>
          <input
            id="signup-username"
            className="mt-1 w-full border rounded px-3 py-2"
            placeholder="yourname"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </div>

        <PasswordField
          id="signup-password"
          label="Create a password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          required
        />

        {err && <p className="text-red-600 text-sm">{err}</p>}

        <button
          disabled={loading}
          className="cursor-pointer w-full px-4 py-2 rounded bg-black text-white disabled:opacity-50"
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
        className="cursor-pointer w-full rounded-xl border py-2 text-sm flex items-center justify-center gap-3"
        aria-label="Continue with Google"
        type="button"
      >
        <NextImage
        src="/icons/googleicon.png"
        alt=""
        width={18}
        height={18}
        className="inline-block"
        priority
        />
        <span>
        Continue with Google</span>
         </button>

      <p className="mt-3 text-sm">
        Already have an account?{" "}
        <Link
          className="cursor-pointer underline"
          href={`/auth/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}
        >
          Log in
        </Link>
      </p>
    </main>
  );
}
