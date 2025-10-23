// src/app/settings/page.tsx

"use client";

import { useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

/* ----------------------------- Types ----------------------------- */

interface ChangeEmailBody {
  new_email: string;
  password?: string;
  reauth_token?: string;
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
  current_password?: string;
  new_password: string;
  reauth_token?: string;
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

/** IMPORTANT: also support NEXT_PUBLIC_API_URL (your current env) */
const API_BASE =
  (process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_API_BASE ||
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

/* ------------------------- Google ID helper ------------------------- */
/** We keep this here so you don't need another file. */
declare global {
  interface Window {
    google?: any;
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";

function loadGis(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("No window"));
    if (window.google?.accounts?.id) return resolve();

    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
}

/** Get a fresh Google ID token from GIS with FedCM → legacy prompt fallback */
async function getGoogleIdTokenOnClient(): Promise<string> {
  if (typeof window === "undefined") throw new Error("Must be called in the browser");
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("Missing NEXT_PUBLIC_GOOGLE_CLIENT_ID");

  await loadGis();

  async function tryPrompt(useFedCM: boolean): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        try {
          window.google?.accounts?.id?.cancel?.();
        } catch {}
      };

      // (Re)initialize with desired FedCM setting
      window.google.accounts.id.initialize({
        client_id: clientId,
        // This callback gives us the ID token (JWT) in resp.credential
        callback: (resp: { credential?: string }) => {
          if (settled) return;
          if (resp?.credential) {
            settled = true;
            cleanup();
            resolve(resp.credential);
          } else {
            settled = true;
            cleanup();
            reject(new Error("No credential returned from Google"));
          }
        },
        // UX knobs
        auto_select: false,
        cancel_on_tap_outside: true,
        // Key line: toggle FedCM usage
        use_fedcm_for_prompt: useFedCM,
        // Helps in Safari/ITP contexts
        itp_support: true,
      });

      window.google.accounts.id.prompt((notification: any) => {
        const notDisplayed = notification?.getNotDisplayedReason?.();
        const skipped = notification?.getSkippedReason?.();
        const reason = notDisplayed || skipped;

        // If it never displayed or was skipped, treat as failure so we can fallback
        if (!settled && reason) {
          settled = true;
          cleanup();
          reject(new Error(String(reason)));
        }
      });

      // Safety timeout
      setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("Google reauth timed out"));
        }
      }, 30_000);
    });
  }

  // 1) Try with FedCM (modern path)
  try {
    return await tryPrompt(true);
  } catch (e: any) {
    const msg = String(e?.message || e);

    // 2) If FedCM is disabled / blocked / network-rejected, retry without FedCM
    // Common reasons: "user_cancel", "opt_out_or_no_session", "unknown_reason",
    // "suppressed_by_user", "browser_not_supported", or the console's NetworkError
    const looksLikeFedCMBlock =
      /fedcm|networkerror|notdisplayed|skipped|suppressed|unknown|browser|disabled/i.test(msg);

    if (looksLikeFedCMBlock) {
      try {
        return await tryPrompt(false); // legacy prompt path
      } catch (e2) {
        throw new Error(
          "Google reauth was blocked or dismissed. Please allow third-party sign-in for this site (key/person icon near the URL), or try again."
        );
      }
    }

    // If the error wasn't FedCM-related, surface it
    throw e;
  }
}

/** Exchange a Google ID token for a short-lived reauth_token on your backend */
async function mintReauthToken(idToken: string, bearer?: string | null): Promise<string> {
  const res = await fetch(api("/api/auth/reauth/google"), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ id_token: idToken }),
  });
  const data = await safeJson<{ reauth_token?: string; error?: string }>(res);
  if (!res.ok || !data?.reauth_token) {
    throw new Error(data?.error || "Google reauth failed");
  }
  return data.reauth_token;
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

  // password visibility toggles
  const [showEmailPw, setShowEmailPw] = useState(false);
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);

  /* ----------------------- Password-path submitters ----------------------- */

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
          (res.status === 404
            ? "Endpoint not found (check API path / auth header)"
            : `Failed to change email (status ${res.status})`);
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
          (res.status === 404
            ? "Endpoint not found (check API path / auth header)"
            : `Failed to change password (status ${res.status})`);
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

  /* --------------------- Google-reauth submitters --------------------- */

  async function verifyWithGoogleAndSaveEmail() {
    setEmailBusy(true);
    setEmailErr(null);
    setEmailMsg(null);
    try {
      const idToken = await getGoogleIdTokenOnClient();
      const reauth = await mintReauthToken(idToken, bearer);

      const res = await fetch(api("/api/auth/change-email"), {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({
          new_email: newEmail,
          reauth_token: reauth,
        } satisfies ChangeEmailBody),
      });

      const data = await safeJson<ChangeEmailResponse>(res);
      if (!res.ok) throw new Error((data as any)?.error || "Failed to change email");

      const msg =
        (data && "message" in data && typeof data.message === "string" && data.message) ||
        (data && "requires_email_verify" in data && data.requires_email_verify
          ? "Email updated. Please check your inbox to verify the new address."
          : "Email updated.");
      setEmailMsg(msg);
      setEmailPassword("");
    } catch (e) {
      setEmailErr(getErrorMessage(e, "Failed to change email"));
    } finally {
      setEmailBusy(false);
    }
  }

  async function verifyWithGoogleAndSavePassword() {
    setPwBusy(true);
    setPwErr(null);
    setPwMsg(null);
    try {
      const idToken = await getGoogleIdTokenOnClient();
      const reauth = await mintReauthToken(idToken, bearer);

      const res = await fetch(api("/api/auth/change-password"), {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({
          new_password: newPassword,
          reauth_token: reauth,
        } satisfies ChangePasswordBody),
      });

      const data = await safeJson<ChangePasswordResponse>(res);
      if (!res.ok) throw new Error((data as any)?.error || "Failed to change password");

      const msg =
        (data && "message" in data && typeof data.message === "string" && data.message) ||
        "Password updated. Please sign in again.";
      setPwMsg(msg);
      setCurrentPassword("");
      setNewPassword("");
    } catch (e) {
      setPwErr(getErrorMessage(e, "Failed to change password"));
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="relative overflow-hidden bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 min-h-screen">
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
              <div className="relative">
                <input
                  id="emailPassword"
                  type={showEmailPw ? "text" : "password"}
                  value={emailPassword}
                  onChange={(ev) => setEmailPassword(ev.target.value)}
                  className="w-full rounded border px-3 py-2 pr-10"
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowEmailPw((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-neutral-600 hover:text-neutral-900 cursor-pointer"
                  aria-label={showEmailPw ? "Hide password" : "Show password"}
                  title={showEmailPw ? "Hide password" : "Show password"}
                >
                  {showEmailPw ? (
                    // eye-off
                    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 3l18 18" />
                      <path d="M10.58 10.58A3 3 0 0 0 12 15a3 3 0 0 0 2.42-4.42" />
                      <path d="M6.16 6.16A18.9 18.9 0 0 0 1 12s4 8 11 8c1.78 0 3.46-.42 5-.97" />
                      <path d="M21.05 17.94A18.9 18.9 0 0 0 23 12s-4-8-11-8c-.73 0-1.44.08-2.12.24" />
                    </svg>
                  ) : (
                    // eye
                    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {emailErr && <p className="text-sm text-red-600">{emailErr}</p>}
            {emailMsg && <p className="text-sm text-green-700">{emailMsg}</p>}

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={emailBusy}
                className="cursor-pointer rounded bg-blue-700 px-4 py-2 font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
              >
                {emailBusy ? "Saving..." : "Save with Password"}
              </button>

              <button
                type="button"
                onClick={verifyWithGoogleAndSaveEmail}
                disabled={emailBusy}
                className="cursor-pointer rounded bg-neutral-800 px-4 py-2 font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
                title="Verify with Google instead of entering current password"
              >
                {emailBusy ? "Verifying..." : "Verify with Google & Save"}
              </button>
            </div>

            <p className="mt-2 text-xs text-neutral-600">
              Your email will not update until you verify the new email address.
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
              <div className="relative">
                <input
                  id="currentPassword"
                  type={showCurrentPw ? "text" : "password"}
                  value={currentPassword}
                  onChange={(ev) => setCurrentPassword(ev.target.value)}
                  className="w-full rounded border px-3 py-2 pr-10"
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPw((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-neutral-600 hover:text-neutral-900 cursor-pointer"
                  aria-label={showCurrentPw ? "Hide password" : "Show password"}
                  title={showCurrentPw ? "Hide password" : "Show password"}
                >
                  {showCurrentPw ? (
                    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 3l18 18" />
                      <path d="M10.58 10.58A3 3 0 0 0 12 15a3 3 0 0 0 2.42-4.42" />
                      <path d="M6.16 6.16A18.9 18.9 0 0 0 1 12s4 8 11 8c1.78 0 3.46-.42 5-.97" />
                      <path d="M21.05 17.94A18.9 18.9 0 0 0 23 12s-4-8-11-8c-.73 0-1.44.08-2.12.24" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="newPassword" className="mb-1 block text-sm font-medium">
                New Password (min 8 chars)
              </label>
              <div className="relative">
                <input
                  id="newPassword"
                  type={showNewPw ? "text" : "password"}
                  value={newPassword}
                  onChange={(ev) => setNewPassword(ev.target.value)}
                  className="w-full rounded border px-3 py-2 pr-10"
                  placeholder="••••••••"
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPw((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-neutral-600 hover:text-neutral-900 cursor-pointer"
                  aria-label={showNewPw ? "Hide password" : "Show password"}
                  title={showNewPw ? "Hide password" : "Show password"}
                >
                  {showNewPw ? (
                    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 3l18 18" />
                      <path d="M10.58 10.58A3 3 0 0 0 12 15a3 3 0 0 0 2.42-4.42" />
                      <path d="M6.16 6.16A18.9 18.9 0 0 0 1 12s4 8 11 8c1.78 0 3.46-.42 5-.97" />
                      <path d="M21.05 17.94A18.9 18.9 0 0 0 23 12s-4-8-11-8c-.73 0-1.44.08-2.12.24" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {pwErr && <p className="text-sm text-red-600">{pwErr}</p>}
            {pwMsg && <p className="text-sm text-green-700">{pwMsg}</p>}

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={pwBusy}
                className="cursor-pointer rounded bg-blue-700 px-4 py-2 font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
              >
                {pwBusy ? "Saving..." : "Save with Password"}
              </button>

              <button
                type="button"
                onClick={verifyWithGoogleAndSavePassword}
                disabled={pwBusy || newPassword.length < 8}
                className="cursor-pointer rounded bg-neutral-800 px-4 py-2 font-semibold text-white transition hover:brightness-110 disabled:opacity-60"
                title="Verify with Google instead of entering current password"
              >
                {pwBusy ? "Verifying..." : "Verify with Google & Save"}
              </button>
            </div>

            <p className="mt-2 text-xs text-neutral-600">
              After clicking Save Password, your password is automatically changed.
            </p>
          </form>
        </section>
      </div>
    </div>
  );
}
