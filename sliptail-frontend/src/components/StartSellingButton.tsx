// sliptail-frontend/src/components/StartSellingButton.tsx
"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";

/* ---------------------------- Types & Guards ---------------------------- */

type Creator = {
  user_id?: number;
  creator_id?: number;
  display_name?: string | null;
  bio?: string | null;
  profile_image?: string | null;
  is_profile_complete?: boolean;
  is_active?: boolean;
  gallery?: string[];
  categories?: string[];
};

type CreatorStatus = {
  profileComplete: boolean;
  stripeConnected: boolean;
  hasPublishedProduct: boolean;
  isActive: boolean;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isCreator(v: unknown): v is Creator {
  if (!isRecord(v)) return false;
  // Loose guard: accept if it has an id (user_id or creator_id) or common profile keys
  return (
    "user_id" in v ||
    "creator_id" in v ||
    "display_name" in v ||
    "is_profile_complete" in v ||
    "is_active" in v
  );
}

function extractCreator(v: unknown): Creator | null {
  if (isRecord(v) && "creator" in v && isCreator((v as Record<string, unknown>).creator)) {
    return (v as { creator?: Creator }).creator ?? null;
  }
  if (isCreator(v)) return v as Creator;
  return null;
}

/* ----------------------------- Config Helper ---------------------------- */

function toApiBase(): string {
  const env = (process.env.NEXT_PUBLIC_API_URL || "").trim();
  // If empty, same-origin; otherwise use the provided base (without trailing slash)
  return env.replace(/\/$/, "");
}

/* ------------------------------ API Helpers ----------------------------- */

/** Seed role=creator and insert a shell row in creator_profiles (backend does both). */
async function postBecome(apiBase: string): Promise<void> {
  const urls = [`${apiBase}/api/creators/become`, `${apiBase}/api/creator/become`];

  let lastErr = "Become failed";
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });

      // Some backends set cookies and return minimal bodies; treat any 2xx as success.
      if (res.ok) return;

      // Capture server error text if present
      const text = await res.text().catch(() => "");
      lastErr = text || `Become failed (${res.status})`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : "Network error during become";
    }
  }
  throw new Error(lastErr);
}

/** Initialize/ensure a creator profile exists (idempotent). */
async function postSetup(apiBase: string): Promise<Creator | null> {
  // Try singular first, then plural for compatibility with both routers
  const endpoints = [`${apiBase}/api/creator/setup`, `${apiBase}/api/creators/setup`];

  let lastMessage = "Setup failed";
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });

      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          // ignore bad JSON; fall through
        }
      }

      if (res.ok) {
        const found = extractCreator(parsed);
        return found ?? null;
      }

      // Some legacy handlers returned non-2xx with a valid creator body—treat that as success.
      const maybeCreator = extractCreator(parsed);
      if (maybeCreator) return maybeCreator;

      // keep last error message for context
      if (isRecord(parsed) && typeof parsed.error === "string") {
        lastMessage = parsed.error;
      } else {
        lastMessage = `Setup failed (${res.status})`;
      }
    } catch (e) {
      lastMessage = e instanceof Error ? e.message : "Network error during setup";
    }
  }
  throw new Error(lastMessage);
}

async function fetchCreatorStatus(apiBase: string): Promise<CreatorStatus | null> {
  try {
    const res = await fetch(`${apiBase}/api/me/creator-status`, {
      method: "GET",
      credentials: "include",
      headers: { "Cache-Control": "no-store" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!isRecord(data)) return null;

    const status: Partial<CreatorStatus> = {
      profileComplete: typeof data.profileComplete === "boolean" ? data.profileComplete : undefined,
      stripeConnected: typeof data.stripeConnected === "boolean" ? data.stripeConnected : undefined,
      hasPublishedProduct:
        typeof data.hasPublishedProduct === "boolean" ? data.hasPublishedProduct : undefined,
      isActive: typeof data.isActive === "boolean" ? data.isActive : undefined,
    };

    // require 'isActive' at minimum to consider it valid
    return typeof status.isActive === "boolean" ? (status as CreatorStatus) : null;
  } catch {
    return null;
  }
}

/* -------------------------------- Component ----------------------------- */

export default function StartSellingButton({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { user } = useAuth(); // assumes your AuthProvider returns { user }
  const apiBase = useMemo(() => toApiBase(), []);
  const [busy, setBusy] = useState(false);

  async function handleClick(): Promise<void> {
    if (busy) return;

    // Not logged in → go to signup
    if (!user) {
      router.push("/auth/signup");
      return;
    }

    setBusy(true);
    try {
      // 1) Ensure role + shell row via /become (idempotent)
      try {
        await postBecome(apiBase);
      } catch {
        // If /become endpoint is not present yet or fails non-critically, continue
      }

      // 2) Belt & suspenders: ensure setup row exists (idempotent)
      try {
        await postSetup(apiBase);
      } catch {
        // If setup endpoint doesn’t exist yet, continue gracefully to setup UI
      }

      // 3) Check status to decide destination
      const status = await fetchCreatorStatus(apiBase);
      if (status?.isActive) {
        router.push("/dashboard");
        return;
      }

      // Default path: take them to the setup flow
      router.push("/creator/setup?created=1");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className={`${className ?? ""} cursor-pointer disabled:cursor-not-allowed`}
      aria-disabled={busy}
    >
      {children}
    </button>
  );
}