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

  return (
    <div className="fixed inset-x-0 bottom-4 flex justify-center px-4">
      <div
        role="status"
        className="max-w-md w-full rounded-2xl border bg-white/95 shadow-lg backdrop-blur p-4"
      >
        <div className="flex items-start gap-3">
          <div className="text-2xl">{flash.kind === "success" ? "✅" : "ℹ️"}</div>
          <div>
            <div className="font-semibold">{flash.title}</div>
            {flash.message ? (
              <div className="text-sm text-neutral-700 mt-0.5">{flash.message}</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
