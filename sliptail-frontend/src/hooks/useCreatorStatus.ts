"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

/**
 * Returns { isCreator, loading }.
 * Keeps the existing flow: 200 from /api/creators/:id => true, 404 => false.
 * Adds:
 *  - Optimistic local flag (creatorSetupDone) so the nav updates immediately after setup.
 *  - Optional check to /api/creator/status (if implemented); otherwise ignored.
 */
export function useCreatorStatus() {
  const { user } = useAuth();

  // Optimistic initial state (so nav updates immediately after setup success)
  const [isCreator, setIsCreator] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("creatorSetupDone") === "true";
    }
    return false;
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let abort = false;

    async function check() {
      if (!user?.id) {
        if (!abort) {
          setIsCreator(false);
          setLoading(false);
        }
        return;
      }

      setLoading(true);

      // 1) OPTIONAL: Try a lightweight status endpoint if you mounted it.
      //    If it doesn't exist or errors, we silently fall back to the legacy check.
      try {
        const res = await fetch("/api/creator/status", { credentials: "include" });
        if (!abort && res.ok) {
          const data = await res.json().catch(() => ({}));
          const active = Boolean(data && data.active);
          if (active) {
            setIsCreator(true);
            try { localStorage.setItem("creatorSetupDone", "true"); } catch {}
          }
          // If not active, don't force false yet—do the legacy check next.
        }
      } catch {
        // ignore; we'll do the legacy check below
      }

      // 2) LEGACY (original) flow: public creator profile check
      try {
        const res = await fetch(`/api/creators/${user.id}`, {
          method: "GET",
          credentials: "include",
        });
        if (abort) return;

        if (res.ok) {
          setIsCreator(true);
          try { localStorage.setItem("creatorSetupDone", "true"); } catch {}
        } else if (res.status === 404) {
          setIsCreator(false);
          try { localStorage.removeItem("creatorSetupDone"); } catch {}
        } else {
          // transient error: keep previous value; don't crash UI
        }
      } catch {
        if (!abort) {
          // network error — keep whatever we had (optimistic or previous)
        }
      } finally {
        if (!abort) setLoading(false);
      }
    }

    check();
    return () => { abort = true; };
  }, [user?.id]);

  return { isCreator, loading };
}