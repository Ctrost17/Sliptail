"use client";
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function PurchasesSuccessAlias() {
  const router = useRouter();
  const sp = useSearchParams();
  const sessionId = sp.get("session_id") || "";
  const pid = sp.get("pid") || "";
  const action = sp.get("action") || "";

  useEffect(() => {
    const q = new URLSearchParams();
    if (sessionId) q.set("sid", sessionId); // your success page can accept sid
    if (pid) q.set("pid", pid);
    if (action) q.set("action", action);
    router.replace(`/checkout/success${q.size ? `?${q.toString()}` : ""}`);
  }, [router, sessionId, pid, action]);

  return null;
}