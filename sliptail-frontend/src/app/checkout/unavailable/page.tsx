"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";

export const dynamic = "force-dynamic";

export default function CheckoutUnavailablePage() {
  const router = useRouter();
  const search = useSearchParams();
  const pid = useMemo(() => search.get("pid"), [search]);

  const message =
    "This creator is still finishing their payout setup. Please try again later.";

  const handleBack = () => {
    // Prefer going back in history; if that fails, go to product page
    if (typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
    } else if (pid) {
      router.replace(`/products/${encodeURIComponent(pid)}`);
    } else {
      router.replace("/"); // ultimate fallback
    }
  };

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-neutral-900">
          Creator not ready yet
        </h1>
        <p className="mt-3 text-sm text-neutral-600">
          {message}
        </p>

        <button
          type="button"
          onClick={handleBack}
          className="mt-6 inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium border border-neutral-300 hover:bg-neutral-100 transition"
        >
          ← Go back
        </button>
      </div>
    </div>
  );
}
