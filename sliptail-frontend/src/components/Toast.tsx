"use client";
import { useEffect, useState } from "react";
import { consumeFlash, FlashPayload, setFlash } from "@/lib/flash";

export default function Toast() {
  const [flash, setFlashState] = useState<FlashPayload | null>(null);

  useEffect(() => {
    // 1) URL param delivery (iOS-safe)
    try {
      const url = new URL(window.location.href);
      const urlToast = url.searchParams.get("toast");
      if (urlToast) {
        // Option A: show immediately (no storage required)
        setFlashState({ kind: "success", title: urlToast, ts: Date.now() });

        // Optional: also drop into localStorage so other listeners/pages see it
        try { setFlash({ kind: "success", title: urlToast, ts: Date.now() }); } catch {}

        // Remove the param so it doesn’t reappear on refresh
        url.searchParams.delete("toast");
        const clean = `${url.pathname}${url.search ? `?${url.searchParams}` : ""}${url.hash}`;
        window.history.replaceState(null, "", clean);
      }
    } catch {}

    // 2) Flash-from-localStorage (desktop & when storage wins the race)
    const f = consumeFlash();
    if (f) setFlashState(f);

    // 3) Listen for storage changes (cross-tab + same-tab shim)
    function onStorage(e: StorageEvent) {
      if (e.key === "sliptail_flash" && e.newValue) {
        const f = consumeFlash();
        if (f) setFlashState(f);
      }
    }
    window.addEventListener("storage", onStorage);

    // Same-tab shim: monkey-patch setItem to emit a storage-like event
    const origSetItem = localStorage.setItem;
    localStorage.setItem = function (key: string, value: string) {
      origSetItem.call(this, key, value);
      if (key === "sliptail_flash") {
        window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
      }
    };

    return () => {
      window.removeEventListener("storage", onStorage);
      localStorage.setItem = origSetItem;
    };
  }, []);

  // Auto-hide
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlashState(null), 3500);
    return () => clearTimeout(t);
  }, [flash]);

  if (!flash) return null;
  const isSuccess = flash.kind === "success";

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[1100] flex justify-center px-4"
      // keep clear of iOS safe-area and below any fixed header
      style={{ top: "max(env(safe-area-inset-top), 1rem)" }}
    >
      <div
        role="status"
        className={`pointer-events-auto max-w-xl w-full rounded-xl border shadow-lg backdrop-blur px-5 py-4 flex gap-4 items-start ${
          isSuccess ? "border-green-500/30 bg-white/95" : "border-neutral-300 bg-white/95"
        }`}
      >
        <div
          className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-full text-2xl ${
            isSuccess ? "bg-green-500 text-white" : "bg-neutral-200"
          }`}
          aria-hidden="true"
        >
          {isSuccess ? "✔" : "ℹ"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold leading-snug text-sm md:text-base truncate">{flash.title}</div>
          {flash.message ? (
            <div className="text-xs md:text-sm text-neutral-600 mt-1 line-clamp-3">{flash.message}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
