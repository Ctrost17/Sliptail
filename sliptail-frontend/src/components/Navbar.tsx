"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider"; // ⬅️ use context instead of SWR
import { useCreatorStatus } from "@/hooks/useCreatorStatus";
import useUnreadNotifications from "@/hooks/useUnreadNotifications";

/* ---------------------------- Component --------------------------- */

export default function Navbar() {
  const router = useRouter();

  // Auth from context (updates immediately when idle logout fires)
  const { user, logout } = useAuth();

  // Creator status via your hook
  const { isCreator } = useCreatorStatus();

  // Unread notifications (SSE + polling fallback)
  const { unread, hasUnread, refresh } = useUnreadNotifications({ loadList: false });

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // fetch unread on mount
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // re-fetch when user session becomes available/changes
  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  // tiny polling fallback
  useEffect(() => {
    const id = setInterval(() => void refresh(), 30000);
    return () => clearInterval(id);
  }, [refresh]);

  // Close menu on outside click
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    if (menuOpen) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  // Keep badge fresh when opening the menu
  useEffect(() => {
    if (menuOpen) void refresh();
  }, [menuOpen, refresh]);

  function go(path: string) {
    setMenuOpen(false);
    router.push(path);
  }

  async function onLogoutClick() {
    await logout();               // context handles server + local clear
    setMenuOpen(false);
    router.replace("/");
    router.refresh();
    if (typeof window !== "undefined") {
      window.location.replace("/");
    }
  }

  const showUnreadDot = Boolean(user) && hasUnread;
  const unreadForBadge = Boolean(user) ? unread : 0;

  return (
    <header data-app-nav className="sticky top-0 z-40 w-full border-b bg-white/70 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-3 md:px-4 py-2 md:py-3">
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
          <div className="flex items-center gap-2 sm:gap-2 md:gap-3">
            <Link
              href="/auth/login"
              className="rounded-2xl border border-black px-3 py-1.5 text-xs font-semibold text-black hover:bg-neutral-100 sm:px-4 sm:py-2 sm:text-sm shrink-0 whitespace-nowrap"
            >
              Sign in
            </Link>
            <Link
              href="/auth/signup?next=%2Fcreator%2Fsetup"
              className="rounded-2xl bg-black px-3 py-1.5 text-xs font-semibold text-white hover:bg-black/90 sm:px-4 sm:py-2 sm:text-sm shrink-0 whitespace-nowrap"
            >
              Become a creator
            </Link>
          </div>
        ) : (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              aria-label="Open menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border hover:bg-neutral-50 cursor-pointer"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {showUnreadDot && (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 inline-block h-2.5 w-2.5 rounded-full bg-red-600 ring-2 ring-white"
                />
              )}
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 mt-2 w-60 rounded-2xl border bg-white p-1 shadow-lg z-50"
              >
                {isCreator ? (
                  <>
                    <MenuItem onClick={() => go("/dashboard")}>Creator Dashboard</MenuItem>
                    <MenuItem onClick={() => go("/purchases")}>My Purchases</MenuItem>
                    <MenuItem onClick={() => go("/notifications")} trailing={<UnreadBadge count={unreadForBadge} />}>
                      Notifications
                    </MenuItem>
                    <MenuItem onClick={() => go("/settings")}>Settings</MenuItem>
                    <MenuItem onClick={onLogoutClick}>Log out</MenuItem>
                  </>
                ) : (
                  <>
                    <MenuItem onClick={() => go("/purchases")}>My Purchases</MenuItem>
                    <MenuItem onClick={() => go("/notifications")} trailing={<UnreadBadge count={unreadForBadge} />}>
                      Notifications
                    </MenuItem>
                    <MenuItem onClick={() => go("/settings")}>Settings</MenuItem>
                    <MenuItem onClick={() => go("/creator/setup")}>Become a Creator</MenuItem>
                    <MenuItem onClick={onLogoutClick}>Log out</MenuItem>
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
              <button onClick={() => setConfirmOpen(false)} className="rounded-xl border px-4 py-2 text-sm">
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
  trailing,
}: {
  children: React.ReactNode;
  onClick: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-neutral-100 cursor-pointer"
    >
      <span className="flex w-full items-center justify-between">
        <span>{children}</span>
        {trailing}
      </span>
    </button>
  );
}

function UnreadBadge({ count }: { count: number }) {
  if (!count || count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white"
      aria-label={`${label} unread notifications`}
    >
      {label}
    </span>
  );
}
