"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import useSWR, { mutate } from "swr";
import { setAuthToken } from "@/lib/api";
import { saveAuth, loadAuth } from "@/lib/auth";
import { useCreatorStatus } from "@/hooks/useCreatorStatus";

/* ----------------------------- Types ----------------------------- */

interface AuthUser {
  id: number;
  email: string;
  role: "user" | "creator" | "admin" | (string & {});
  email_verified_at?: string | null;
}

/* --------------------------- Fetcher --------------------------- */

const fetcher = async <T,>(url: string): Promise<T> => {
  let token: string | null = null;
  try {
    token = typeof loadAuth === "function" ? loadAuth()?.token ?? null : null;
  } catch {
    token = null;
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { credentials: "include", headers });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
};

/* ---------------------------- Component --------------------------- */

export default function Navbar() {
  const router = useRouter();

  // Auth (server truth)
  const { data: user, error: meErr } = useSWR<AuthUser>("/api/auth/me", fetcher);

  // Creator status via your hook
  const { isCreator } = useCreatorStatus();

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    if (menuOpen) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  // If /api/auth/me 401s, clear any local token to avoid “phantom login”
  useEffect(() => {
    if (!meErr) return;
    try {
      const stored = typeof loadAuth === "function" ? loadAuth() : undefined;
      if (stored?.token) {
        saveAuth({ token: null, user: null });
        setAuthToken(null);
      }
    } catch {
      /* no-op */
    }
  }, [meErr]);

  function go(path: string) {
    setMenuOpen(false);
    router.push(path);
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      /* ignore transport errors; we’ll still clear client state */
    }

    // Clear client auth surfaces
    try {
      saveAuth({ token: null, user: null });
      setAuthToken(null);
      if (typeof window !== "undefined") {
        localStorage.removeItem("creatorSetupDone");
        // Broadcast to other tabs
        localStorage.setItem("auth:logout", String(Date.now()));
      }
    } catch {
      /* noop */
    }

    // Nuke SWR caches so no page shows stale auth
    await mutate(() => true, undefined, { revalidate: false });

    // Make sure menus close quickly
    setMenuOpen(false);

    // Hard navigate home to fully reset (also triggers server components to refetch)
    // router.replace + refresh covers App Router, location.replace is a final safety.
    router.replace("/");
    router.refresh();
    if (typeof window !== "undefined") {
      // Safety: ensure no stale caches keep UI around (especially on static home)
      window.location.replace("/");
    }
  }

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-white/70 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        {/* Left: Logo */}
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-3" aria-label="Home">
            <Image src="/sliptail-logofull.png" alt="Sliptail" width={130} height={40} />
          </Link>
        </div>

        {/* Center: (empty—removed Creators & Creator Dashboard) */}
        <nav className="hidden md:flex" aria-hidden />

        {/* Right: auth area */}
        {!user ? (
          <div className="flex items-center gap-2">
            <Link
              href="/auth/login"
              className="rounded-2xl border px-4 py-2 text-sm font-semibold hover:bg-neutral-100"
            >
              Sign in
            </Link>
            <Link
              href="/auth/signup?next=%2Fcreator%2Fsetup"
              className="rounded-2xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-black/90"
            >
              Become a creator
            </Link>
          </div>
        ) : (
          <div className="relative" ref={menuRef}>
            <button
              aria-label="Open menu"
              onClick={() => setMenuOpen((v) => !v)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border hover:bg-neutral-50"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>

            {menuOpen && (
              <div className="absolute right-0 mt-2 w-60 rounded-2xl border bg-white p-1 shadow-lg">
                {isCreator ? (
                  <>
                    <MenuItem onClick={() => go("/dashboard")}>Creator Dashboard</MenuItem>
                    <MenuItem onClick={() => go("/purchases")}>My Purchases</MenuItem>
                    <MenuItem onClick={() => go("/notifications")}>Notifications</MenuItem>
                    <MenuItem onClick={() => go("/settings")}>Settings</MenuItem>
                    <MenuItem onClick={logout}>Log out</MenuItem>
                  </>
                ) : (
                  <>
                    <MenuItem onClick={() => go("/purchases")}>My Purchases</MenuItem>
                    <MenuItem onClick={() => go("/notifications")}>Notifications</MenuItem>
                    <MenuItem onClick={() => go("/settings")}>Settings</MenuItem>
                    <MenuItem onClick={() => go("/creator/setup")}>Become a Creator</MenuItem>
                    <MenuItem onClick={logout}>Log out</MenuItem>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Optional confirmation modal – routes to setup */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-5">
            <h3 className="text-lg font-semibold">Ready to start Creating?</h3>
            <p className="text-sm text-neutral-700">
              We’ll guide you through profile, Stripe, and your first product.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="rounded-xl border px-4 py-2 text-sm"
              >
                No
              </button>
              <button
                onClick={() => {
                  setConfirmOpen(false);
                  router.push("/creator/setup");
                }}
                className="rounded-xl bg-black px-4 py-2 text-sm text-white"
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

/* ----------------------------- Subcomponents ---------------------------- */

function MenuItem({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-neutral-100"
    >
      {children}
    </button>
  );
}
