"use client";

import { useEffect, useMemo, useState } from "react";

/* =========================
   Types
========================= */
type Profile = {
  email: string;
  username: string | null;
  has_password: boolean;
  email_verified: boolean;
};

type ApiError = { error: string };

/* =========================
   Helpers
========================= */
function isApiError(x: unknown): x is ApiError {
  return typeof x === "object" && x !== null && "error" in x && typeof (x as { error: unknown }).error === "string";
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON response
  }
  if (!res.ok) {
    const msg = isApiError(data) ? data.error : `Request failed with ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

/** Injects Authorization: Bearer <token> from localStorage */
async function authFetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("authToken") : null;
  const headers: HeadersInit = {
    ...(init.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  return fetchJson<T>(url, { ...init, headers, credentials: init.credentials ?? "include" });
}

/* =========================
   Component
========================= */
export default function SettingsPage() {
  const [profile, setProfile] = useState<Profile | null>(null);

  const [savingProfile, setSavingProfile] = useState(false);
  const [changingPw, setChangingPw] = useState(false);

  const [email, setEmail] = useState<string>("");
  const [username, setUsername] = useState<string>("");

  const [currentPw, setCurrentPw] = useState<string>("");
  const [newPw, setNewPw] = useState<string>("");
  const [confirmPw, setConfirmPw] = useState<string>("");

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apiBase = useMemo(
    () => (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, ""),
    []
  );

  useEffect(() => {
    (async () => {
      setError(null);
      const token = typeof window !== "undefined" ? localStorage.getItem("authToken") : null;
      if (!token) {
        setError("Unauthorized (no token). Please log in.");
        return;
      }
      try {
        const profileData = await authFetchJson<Profile>(`${apiBase}/api/settings/profile`);
        setProfile(profileData);
        setEmail(profileData.email);
        setUsername(profileData.username ?? "");
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to load settings");
      }
    })();
  }, [apiBase]);

  /* ---------- Save Profile (email/username) ---------- */
  type UpdateProfileBody = Partial<Pick<Profile, "email" | "username">>;
  async function saveProfile() {
    if (!profile) return;
    setMessage(null);
    setError(null);
    setSavingProfile(true);

    const body: UpdateProfileBody = {};
    if (email.trim() !== profile.email) body.email = email.trim();
    const normalizedUsername = username.trim() === "" ? null : username.trim();
    if ((normalizedUsername ?? null) !== (profile.username ?? null)) body.username = normalizedUsername;

    if (Object.keys(body).length === 0) {
      setMessage("Nothing to update.");
      setSavingProfile(false);
      return;
    }

    try {
      const updated = await authFetchJson<Pick<Profile, "email" | "username" | "email_verified">>(
        `${apiBase}/api/settings/profile`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      setProfile((prev) => (prev ? { ...prev, ...updated } : prev));
      setMessage(
        "Profile updated." + (body.email ? " We reset your email verification since you changed email." : "")
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to update profile");
    } finally {
      setSavingProfile(false);
    }
  }

  /* ---------- Change Password ---------- */
  async function changePassword() {
    if (!profile) return;
    setMessage(null);
    setError(null);

    if (newPw.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPw !== confirmPw) {
      setError("New password and confirmation do not match.");
      return;
    }

    setChangingPw(true);
    try {
      const body: { new_password: string; current_password?: string } = { new_password: newPw };
      if (profile.has_password) body.current_password = currentPw;

      await authFetchJson<{ ok: boolean }>(`${apiBase}/api/settings/password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setMessage("Password updated.");
      if (!profile.has_password) setProfile({ ...profile, has_password: true });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to change password");
    } finally {
      setChangingPw(false);
    }
  }

  if (!profile) {
    return <main className="max-w-3xl mx-auto p-4">Loading…</main>;
  }

  /* =========================
     Render
  ========================= */
  return (
    <main className="max-w-3xl mx-auto p-4 space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      {(message || error) && (
        <div
          className={`rounded-xl border p-3 text-sm ${
            error ? "border-red-400 text-red-700 bg-red-50" : "border-green-400 text-green-700 bg-green-50"
          }`}
          role="status"
          aria-live="polite"
        >
          {error || message}
        </div>
      )}

      {/* Account */}
      <section className="rounded-2xl border p-4 space-y-3">
        <h2 className="font-semibold">Account</h2>
        <div className="grid gap-3">
          <label className="grid gap-1">
            <span className="text-sm text-gray-700">
              Email{" "}
              <span className={`ml-1 text-xs ${profile.email_verified ? "text-green-600" : "text-amber-600"}`}>
                {profile.email_verified ? "(verified)" : "(unverified)"}
              </span>
            </span>
            <input
              type="email"
              className="rounded-xl border px-3 py-2"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              placeholder="you@example.com"
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm text-gray-700">Username (optional)</span>
            <input
              type="text"
              className="rounded-xl border px-3 py-2"
              value={username}
              onChange={(ev) => setUsername(ev.target.value)}
              placeholder="e.g. sliptailfan"
            />
          </label>

          <button
            onClick={saveProfile}
            disabled={savingProfile}
            className="mt-1 rounded-xl bg-black text-white py-2 px-4 disabled:opacity-60"
          >
            {savingProfile ? "Saving…" : "Save Profile"}
          </button>
        </div>
      </section>

      {/* Password */}
      <section className="rounded-2xl border p-4 space-y-3">
        <h2 className="font-semibold">Change Password</h2>
        {profile.has_password && (
          <label className="grid gap-1">
            <span className="text-sm text-gray-700">Current password</span>
            <input
              type="password"
              className="rounded-xl border px-3 py-2"
              value={currentPw}
              onChange={(ev) => setCurrentPw(ev.target.value)}
              placeholder="••••••••"
            />
          </label>
        )}

        <label className="grid gap-1">
          <span className="text-sm text-gray-700">
            {profile.has_password ? "New password" : "Set a password"}
          </span>
          <input
            type="password"
            className="rounded-xl border px-3 py-2"
            value={newPw}
            onChange={(ev) => setNewPw(ev.target.value)}
            placeholder="At least 8 characters"
          />
        </label>

        <label className="grid gap-1">
          <span className="text-sm text-gray-700">Confirm new password</span>
          <input
            type="password"
            className="rounded-xl border px-3 py-2"
            value={confirmPw}
            onChange={(ev) => setConfirmPw(ev.target.value)}
            placeholder="Repeat new password"
          />
        </label>

        <button
          onClick={changePassword}
          disabled={changingPw}
          className="mt-1 rounded-xl bg-black text-white py-2 px-4 disabled:opacity-60"
        >
          {changingPw ? "Updating…" : profile.has_password ? "Change Password" : "Set Password"}
        </button>
      </section>
    </main>
  );
}
