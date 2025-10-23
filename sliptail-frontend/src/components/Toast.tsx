// components/Toast.tsx
"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import { consumeFlash, setFlash, type FlashPayload } from "@/lib/flash";

export default function Toast() {
  const [flash, setFlashState] = useState<FlashPayload | null>(null);
  const [mounted, setMounted] = useState(false);
  const [topOffset, setTopOffset] = useState(12);
  const searchParams = useSearchParams();

  // measure navbar so toast sits below it
  useEffect(() => {
    setMounted(true);
    const nav = document.querySelector<HTMLElement>("[data-app-nav]");
    const calc = () => setTopOffset((nav?.offsetHeight ?? 0) + 8);
    calc();
    const ro = nav ? new ResizeObserver(calc) : null;
    window.addEventListener("resize", calc);
    ro?.observe?.(nav!);
    return () => { window.removeEventListener("resize", calc); ro?.disconnect(); };
  }, []);

  // (A) Re-consume ?toast= whenever search params change (works across app-router navigations)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const u = new URL(window.location.href);
      const t = u.searchParams.get("toast");
      if (!t) return;
      const payload: FlashPayload = { kind: "success", title: t, ts: Date.now() };
      setFlashState(payload);
      try { setFlash(payload); } catch {}
      u.searchParams.delete("toast");
      window.history.replaceState(null, "", u.toString());
    } catch {}
  }, [searchParams]);

  // (B) One-time: pull from localStorage + listen for future flashes
  useEffect(() => {
    const f = consumeFlash();
    if (f) setFlashState(f);

    const onStorage = (e: StorageEvent) => {
      if (e.key === "sliptail_flash" && e.newValue) {
        const f = consumeFlash();
        if (f) setFlashState(f);
      }
    };
    window.addEventListener("storage", onStorage);
    const orig = localStorage.setItem;
    localStorage.setItem = function (k: string, v: string) {
      orig.call(this, k, v);
      if (k === "sliptail_flash") {
        window.dispatchEvent(new StorageEvent("storage", { key: k, newValue: v }));
      }
    };
    return () => { window.removeEventListener("storage", onStorage); localStorage.setItem = orig; };
  }, []);

    useEffect(() => {
      if (!flash) return;
      const id = setTimeout(() => setFlashState(null), 3500);
      return () => clearTimeout(id);
    }, [flash]);

    if (!mounted || !flash) return null;
    const isSuccess = flash.kind === "success";

    const node = (
      <div
        className="pointer-events-none fixed inset-x-0 flex justify-center px-4"
        style={{
          top: `calc(env(safe-area-inset-top, 0px) + ${topOffset}px)`,
          zIndex: 2147483647, // higher than any menu
        }}
        aria-live="polite"
        aria-atomic="true"
      >
        <div
          role="status"
          className={`pointer-events-auto max-w-xl w-full rounded-xl border shadow-lg backdrop-blur px-5 py-4 flex gap-4 items-start ${
            isSuccess ? "border-green-500/30 bg-white/95" : "border-neutral-300 bg-white/95"
          }`}
        >
          <div className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-full text-2xl ${
            isSuccess ? "bg-green-500 text-white" : "bg-neutral-200"
          }`}>{isSuccess ? "✔" : "ℹ"}</div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold leading-snug text-sm md:text-base truncate">{flash.title}</div>
            {flash.message ? <div className="text-xs md:text-sm text-neutral-600 mt-1 line-clamp-3">{flash.message}</div> : null}
          </div>
        </div>
      </div>
    );

  return createPortal(node, document.body);
}
