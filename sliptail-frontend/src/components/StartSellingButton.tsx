// sliptail-frontend/src/components/StartSellingButton.tsx
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";

// If you have a helper that returns your API base, use it; otherwise inline "" for same-origin.
function toApiBase() { return ""; }

export default function StartSellingButton({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { user } = useAuth?.() ?? { user: null };
  const apiBase = useMemo(() => toApiBase(), []);
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy) return;

    // 1) Not logged in → signup
    if (!user) {
      router.push("/auth/signup");
      return;
    }

    setBusy(true);
    try {
      // 2) Check readiness
      const res = await fetch(`${apiBase}/api/me/creator-status`, {
        method: "GET",
        credentials: "include",
        headers: { "Cache-Control": "no-store" },
      });

      if (!res.ok) {
        // On any error, fall back to setup (safe)
        router.push("/creator/setup");
        return;
      }

      const j: {
        profileComplete: boolean;
        stripeConnected: boolean;
        hasPublishedProduct: boolean;
        isActive: boolean;
      } = await res.json();

      if (j.isActive) {
        router.push("/dashboard"); // your creator dashboard route
      } else {
        router.push("/creator/setup");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={className}
      aria-disabled={busy}
    >
      {children}
    </button>
  );
}
