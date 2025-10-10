"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";

export default function AuthCompletePage() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const { refresh } = useAuth(); // we'll add this in step 3

  useEffect(() => {
    (async () => {
      try {
        await refresh(); // pulls /api/auth/me with credentials and sets user
      } catch {
        // ignore; user stays unauthenticated if it fails
      } finally {
        router.replace(next.startsWith("/") ? next : "/");
      }
    })();
  }, [next, refresh, router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center text-sm text-gray-500">
      Signing you in…
    </div>
  );
}