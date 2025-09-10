"use client";
import { useEffect, useState } from "react";
import { consumeFlash, FlashPayload } from "@/lib/flash";

export default function Toast() {
  const [flash, setFlash] = useState<FlashPayload | null>(null);

  useEffect(() => {
    const f = consumeFlash();
    if (f) setFlash(f);
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(t);
  }, [flash]);

  if (!flash) return null;

  const isSuccess = flash.kind === "success";
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex justify-center px-4">
      <div
        role="status"
        className={`pointer-events-auto max-w-xl w-full rounded-xl border shadow-lg backdrop-blur px-5 py-4 flex gap-4 items-start ${
          isSuccess
            ? "border-green-500/30 bg-white/95"
            : "border-neutral-300 bg-white/95"
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
          <div className="font-semibold leading-snug text-sm md:text-base truncate">
            {flash.title}
          </div>
          {flash.message ? (
            <div className="text-xs md:text-sm text-neutral-600 mt-1 line-clamp-3">
              {flash.message}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
