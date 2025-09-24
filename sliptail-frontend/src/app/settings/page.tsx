"use client";

import { useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

/* ----------------------------- Types ----------------------------- */

interface ChangeEmailBody {
  new_email: string;
  password: string;
}

interface ChangeEmailOk {
  success: true;
  requires_email_verify?: boolean;
  message?: string;
}

interface ChangeEmailErr {
  error: string;
}

type ChangeEmailResponse = ChangeEmailOk | ChangeEmailErr;

interface ChangePasswordBody {
  current_password: string;
  new_password: string;
}

interface ChangePasswordOk {
  success: true;
  message?: string;
}

interface ChangePasswordErr {
  error: string;
}

type ChangePasswordResponse = ChangePasswordOk | ChangePasswordErr;

/** Minimal shape so we can optionally read a token from the auth context without using `any`. */
interface AuthShape {
  user?: { email?: string | null } | null;
  token?: string | null;
}

/* --------------------------- API helpers --------------------------- */

const API_BASE =
  (process.env.NEXT_PUBLIC_API_BASE ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    "")?.replace(/\/$/, "") || "";

const api = (p: string) => `${API_BASE}${p.startsWith("/") ? p : `/${p}`}`;

/** Safely extract an error message from unknown */
function getErrorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** Parse JSON safely as unknown */
async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    const data = (await res.json()) as unknown;
    return data as T;
  } catch {
    return null;
  }
}

/** Resolve a bearer token from context or localStorage */
function resolveToken(maybeToken?: string | null): string | null {
  if (maybeToken) return maybeToken;
  if (typeof window !== "undefined") {
    try {
      const ls = window.localStorage.getItem("token");
      return ls || null;
    } catch {
      return null;
    }
  }
  return null;
}

/* --------------------------------- Page --------------------------------- */

export default function SettingsPage() {
  const auth = useAuth() as AuthShape;
  const user = auth.user ?? null;
  const bearer = resolveToken(auth.token);

  // Email form state
  const [newEmail, setNewEmail] = useState<string>(user?.email ?? "");
  const [emailPassword, setEmailPassword] = useState<string>("");
  const [emailBusy, setEmailBusy] = useState<boolean>(false);
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [emailErr, setEmailErr] = useState<string | null>(null);

  // Password form state
  const [currentPassword, setCurrentPassword] = useState<string>("");
  const [newPassword, setNewPassword] = useState<string>("");
  const [pwBusy, setPwBusy] = useState<boolean>(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

  async function submitEmail(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEmailBusy(true);
    setEmailErr(null);
    setEmailMsg(null);

    try {
      const body: ChangeEmailBody = { new_email: newEmail, password: emailPassword };
      const headers: HeadersInit = {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      };

      const res = await fetch(api("/api/auth/change-email"), {
        method: "PATCH",
        headers,
        credentials: "include",
        body: JSON.stringify(body),
      });

      const data = await safeJson<ChangeEmailResponse>(res);

      if (!res.ok) {
        const message =
          (data && "error" in data && typeof data.error === "string" && data.error) ||
          (res.status === 404 ? "Endpoint not found (check API path / auth header)" : `Failed to change email (status ${res.status})`);
        throw new Error(message);
      }

      const msg =
        (data && "message" in data && typeof data.message === "string" && data.message) ||
        (data && "requires_email_verify" in data && data.requires_email_verify
          ? "Email updated. Please check your inbox to verify the new address."
          : "Email updated.");

      setEmailMsg(msg);
      setEmailPassword("");
    } catch (err: unknown) {
      setEmailErr(getErrorMessage(err, "Failed to change email"));
    } finally {
      setEmailBusy(false);
    }
  }

  async function submitPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPwBusy(true);
    setPwErr(null);
    setPwMsg(null);

    try {
      const body: ChangePasswordBody = {
        current_password: currentPassword,
        new_password: newPassword,
      };
      const headers: HeadersInit = {
        "Content-Type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      };

      const res = await fetch(api("/api/auth/change-password"), {
        method: "PATCH",
        headers,
        credentials: "include",
        body: JSON.stringify(body),
      });

      const data = await safeJson<ChangePasswordResponse>(res);

      if (!res.ok) {
        const message =
          (data && "error" in data && typeof data.error === "string" && data.error) ||
          (res.status === 404 ? "Endpoint not found (check API path / auth header)" : `Failed to change password (status ${res.status})`);
        throw new Error(message);
      }

      const msg =
        (data && "message" in data && typeof data.message === "string" && data.message) ||
        "Password updated. Please sign in again.";

      setPwMsg(msg);
      setCurrentPassword("");
      setNewPassword("");
    } catch (err: unknown) {
      setPwErr(getErrorMessage(err, "Failed to change password"));
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="mb-8 text-3xl font-bold">Settings</h1>

      {/* Change Email */}
      <section className="mb-10 rounded-2xl bg-white p-6 shadow">
        <h2 className="mb-4 text-xl font-semibold">Change Email</h2>
        <form onSubmit={submitEmail} className="space-y-4">
          <div>
            <label htmlFor="newEmail" className="mb-1 block text-sm font-medium">
              New Email
            </label>
            <input
              id="newEmail"
              type="email"
              value={newEmail}
              onChange={(ev) => setNewEmail(ev.target.value)}
              className="w-full rounded border px-3 py-2"
              placeholder="you@domain.com"
              required
            />
          </div>
          <div>
            <label htmlFor="emailPassword" className="mb-1 block text-sm font-medium">
              Current Password
            </label>
            <input
              id="emailPassword"
              type="password"
              value={emailPassword}
              onChange={(ev) => setEmailPassword(ev.target.value)}
              className="w-full rounded border px-3 py-2"
              placeholder="••••••••"
              required
            />
          </div>
          {emailErr && <p className="text-sm text-red-600">{emailErr}</p>}
          {emailMsg && <p className="text-sm text-green-700">{emailMsg}</p>}
          <button
            type="submit"
            disabled={emailBusy}
            className="rounded bg-green-600 px-4 py-2 font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
          >
            {emailBusy ? "Saving..." : "Save Email"}
          </button>
          <p className="mt-2 text-xs text-neutral-600">
            Your email will not update until you verify the new address.
          </p>
        </form>
      </section>

      {/* Change Password */}
      <section className="rounded-2xl bg-white p-6 shadow">
        <h2 className="mb-4 text-xl font-semibold">Change Password</h2>
        <form onSubmit={submitPassword} className="space-y-4">
          <div>
            <label htmlFor="currentPassword" className="mb-1 block text-sm font-medium">
              Current Password
            </label>
            <input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(ev) => setCurrentPassword(ev.target.value)}
              className="w-full rounded border px-3 py-2"
              placeholder="••••••••"
              required
            />
          </div>
          <div>
            <label htmlFor="newPassword" className="mb-1 block text-sm font-medium">
              New Password (min 8 chars)
            </label>
            <input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(ev) => setNewPassword(ev.target.value)}
              className="w-full rounded border px-3 py-2"
              placeholder="••••••••"
              required
              minLength={8}
            />
          </div>
          {pwErr && <p className="text-sm text-red-600">{pwErr}</p>}
          {pwMsg && <p className="text-sm text-green-700">{pwMsg}</p>}
          <button
            type="submit"
            disabled={pwBusy}
            className="rounded bg-green-600 px-4 py-2 font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
          >
            {pwBusy ? "Saving..." : "Save Password"}
          </button>
          <p className="mt-2 text-xs text-neutral-600">
            After changing your password, you may need to sign in again.
          </p>
        </form>
      </section>
    </div>
  );
}
