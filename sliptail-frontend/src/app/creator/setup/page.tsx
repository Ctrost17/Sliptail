"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

/* ----------------------------- Types ----------------------------- */

type CreatorStatus = {
  profileComplete: boolean;
  stripeConnected: boolean;
  hasPublishedProduct: boolean;
  isActive: boolean;
};

type Category = { id: number; name: string; slug: string };

/* --------------------------- Fetch helpers --------------------------- */

function loadAuthSafe(): { token?: string } | null {
  try {
    const raw = localStorage.getItem("auth");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const fetcher = async <T,>(url: string): Promise<T> => {
  let token: string | null = null;
  try {
    token = loadAuthSafe()?.token ?? null;
  } catch {
    token = null;
  }
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { credentials: "include", headers });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
};

/* ------------------------------ Page ------------------------------ */

export default function CreatorSetupPage() {
  const router = useRouter();
  const search = useSearchParams();

  // Current activation status
  const {
    data: status,
    mutate: mutateStatus,
    isLoading: loadingStatus,
  } = useSWR<CreatorStatus>("/api/me/creator-status", fetcher, {
    revalidateOnFocus: true,
  });

  // Categories: unwrap `{ categories: [...] }` → `Category[]`
  const { data: catResp } = useSWR<{ categories: Category[] }>(
    "/api/categories",
    fetcher
  );
  const allCats: Category[] = Array.isArray(catResp?.categories)
    ? catResp!.categories
    : [];

  // Profile form
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [categories, setCategories] = useState<number[]>([]);

  // uploads + previews
  const [profileImage, setProfileImage] = useState<File | null>(null);
  const [profilePreview, setProfilePreview] = useState<string | null>(null);

  const [galleryFiles, setGalleryFiles] = useState<File[]>([]);
  const [galleryPreviews, setGalleryPreviews] = useState<string[]>([]);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncingStripe, setSyncingStripe] = useState(false);

  // If returning from Stripe (?onboarded=1 or ?refresh=1): sync & clean URL
  useEffect(() => {
    const onboarded = search.get("onboarded");
    const refresh = search.get("refresh");
    if (onboarded === "1" || refresh === "1") {
      (async () => {
        let token: string | null = null;
        try {
          token = loadAuthSafe()?.token ?? null;
        } catch {
          token = null;
        }
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;

        try {
          await fetch("/api/stripe-connect/sync", {
            method: "POST",
            credentials: "include",
            headers,
          }).catch(() => null);
          await mutateStatus(); // refresh status
        } finally {
          const url = new URL(window.location.href);
          url.searchParams.delete("onboarded");
          url.searchParams.delete("refresh");
          window.history.replaceState({}, "", url.toString());
        }
      })();
    }
  }, [search, mutateStatus]);

  // Manual Stripe sync (button)
  async function syncStripeNow() {
    setSyncingStripe(true);
    try {
      let token: string | null = null;
      try {
        token = loadAuthSafe()?.token ?? null;
      } catch {
        token = null;
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      await fetch("/api/stripe-connect/sync", {
        method: "POST",
        credentials: "include",
        headers,
      });
      await mutateStatus();
    } catch {
      // noop
    } finally {
      setSyncingStripe(false);
    }
  }

  // If status flips active (auto-activation after publish), redirect to dashboard
  useEffect(() => {
    if (status?.isActive) {
      router.replace("/dashboard");
      router.refresh();
    }
  }, [status?.isActive, router]);

  /* ------------------------------ Upload handlers ------------------------------ */

  function onPickProfile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null;
    setProfileImage(f || null);
    if (f) {
      const url = URL.createObjectURL(f);
      setProfilePreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } else {
      if (profilePreview) URL.revokeObjectURL(profilePreview);
      setProfilePreview(null);
    }
  }

  const MAX_GALLERY = 4;

  function onPickGallery(e: React.ChangeEvent<HTMLInputElement>) {
    const incoming = Array.from(e.target.files || []);
    if (incoming.length === 0) return;

    const remaining = Math.max(0, MAX_GALLERY - galleryFiles.length);
    if (remaining === 0) {
      if (galleryInputRef.current) galleryInputRef.current.value = "";
      return;
    }

    const toAdd = incoming.slice(0, remaining);
    setGalleryFiles((prev) => [...prev, ...toAdd]);
    const newPreviews = toAdd.map((f) => URL.createObjectURL(f));
    setGalleryPreviews((prev) => [...prev, ...newPreviews]);
    if (galleryInputRef.current) galleryInputRef.current.value = "";
  }

  function removeGalleryAt(idx: number) {
    const nextFiles = galleryFiles.filter((_, i) => i !== idx);
    const nextPreviews = galleryPreviews.filter((_, i) => i !== idx);
    if (galleryPreviews[idx]) URL.revokeObjectURL(galleryPreviews[idx]);
    setGalleryFiles(nextFiles);
    setGalleryPreviews(nextPreviews);
  }

  function moveGallery(from: number, to: number) {
    if (to < 0 || to >= galleryFiles.length) return;
    const files = [...galleryFiles];
    const previews = [...galleryPreviews];
    const [f] = files.splice(from, 1);
    const [p] = previews.splice(from, 1);
    files.splice(to, 0, f);
    previews.splice(to, 0, p);
    setGalleryFiles(files);
    setGalleryPreviews(previews);
  }

  useEffect(() => {
    return () => {
      if (profilePreview) URL.revokeObjectURL(profilePreview);
      galleryPreviews.forEach((p) => URL.revokeObjectURL(p));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------ Save profile ------------------------------ */

  const missingRequired =
    !displayName.trim() || !bio.trim() || !profileImage || galleryFiles.length !== 4;

  async function saveProfile() {
    setSaveError(null);

    if (missingRequired) {
      setSaveError(
        !displayName.trim()
          ? "Display name is required."
          : !bio.trim()
          ? "Short bio is required."
          : !profileImage
          ? "Profile image is required."
          : "Please select exactly four gallery photos."
      );
      return;
    }

    setSaving(true);
    try {
      let token: string | null = null;
      try {
        token = loadAuthSafe()?.token ?? null;
      } catch {
        token = null;
      }
      const authHeader: Record<string, string> = {};
      if (token) authHeader.Authorization = `Bearer ${token}`;

      // Build multipart form
      const fd = new FormData();
      fd.append("display_name", displayName.trim());
      fd.append("bio", bio.trim());
      fd.append("profile_image", profileImage as Blob);
      galleryFiles.forEach((f) => fd.append("gallery", f));

      // Try multipart on /me
      let profRes = await fetch("/api/creators/me", {
        method: "POST",
        credentials: "include",
        headers: authHeader,
        body: fd,
      });

      // If backend doesn't accept multipart on /me, fall back to two-step flow
      if (profRes.status === 415 || profRes.status === 400) {
        const upRes = await fetch("/api/creators/me/media", {
          method: "POST",
          credentials: "include",
          headers: authHeader,
          body: fd,
        });

        if (!upRes.ok) {
          const msg = await upRes.text().catch(() => "");
          throw new Error(msg || "Failed to upload images");
        }

        type MediaResp = { profile_image?: string; gallery?: string[] };
        const mediaUnknown: unknown = await upRes.json();
        const media = mediaUnknown as MediaResp;

        const profile_image_url =
          typeof media.profile_image === "string" ? media.profile_image : null;
        const gallery_urls = Array.isArray(media.gallery) ? media.gallery : [];

        profRes = await fetch("/api/creators/me", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...authHeader,
          },
          body: JSON.stringify({
            display_name: displayName.trim(),
            bio: bio.trim(),
            profile_image: profile_image_url,
            gallery: gallery_urls,
          }),
        });
      }

      // Optimistically mark complete in SWR, then confirm below
      void mutateStatus(
        (prev) =>
          prev
            ? {
                ...prev,
                profileComplete: true,
              }
            : prev,
        false
      );

      // Save categories (non-fatal)
      try {
        const catRes = await fetch("/api/creators/me/categories", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ category_ids: categories }),
        });
        if (!catRes.ok) {
          console.warn("categories save failed:", await catRes.text().catch(() => ""));
        }
      } catch (catErr) {
        console.warn("categories save error:", (catErr as Error)?.message || catErr);
      }

      if (!profRes.ok) {
        await mutateStatus(); // revalidate
        const latest = await fetcher<CreatorStatus>("/api/me/creator-status").catch(
          () => null as unknown as CreatorStatus
        );
        if (latest?.profileComplete) {
          setSaveError(null);
          return;
        }
        const msg = await profRes.text().catch(() => "");
        throw new Error(msg || "Failed to save profile");
      }

      await mutateStatus();
      setSaveError(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function connectStripe() {
    let token: string | null = null;
    try {
      token = loadAuthSafe()?.token ?? null;
    } catch {
      token = null;
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch("/api/stripe-connect/create-link", {
      method: "POST",
      credentials: "include",
      headers,
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      alert(`Stripe link error: ${res.status} ${msg || ""}`);
      return;
    }
    const data = await res.json().catch(() => null);
    if (data?.url) {
      window.location.href = data.url;
    } else {
      alert("Stripe link response was missing a URL.");
    }
  }

  function toggleCategory(id: number) {
    setCategories((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  const readyForProduct = useMemo(
    () => !!status?.profileComplete && !!status?.stripeConnected,
    [status]
  );

  // Guard Link navigation if not ready
  function onProductLinkClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!readyForProduct) {
      e.preventDefault();
      alert("Complete your profile and connect Stripe first.");
    }
  }

  return (
    <div className="relative overflow-hidden bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 min-h-screen">
      <main className="mx-auto max-w-3xl px-4 py-8 space-y-8">
        <h1 className="text-2xl font-bold text-black">Creator Setup</h1>

        {/* Step 1: Profile */}
        <section className="rounded-2xl border bg-white p-4 text-black space-y-4">
          <header className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">1) Your Profile</h2>
            {status?.profileComplete ? (
              <span className="text-green-700 text-sm">Complete ✓</span>
            ) : (
              <span className="text-orange-700 text-sm">Incomplete</span>
            )}
          </header>

          {/* Display name */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">Display name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How your name appears on your creator card"
              className="w-full rounded-xl border px-3 py-2"
            />
          </div>

          {/* Bio */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">Short bio</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={5}
              placeholder="Short bio to explain who you are…"
              className="w-full rounded-xl border px-3 py-2"
            />
            <div className="text-xs text-neutral-600">
              Keep it concise but descriptive. You can update this anytime.
            </div>
          </div>

          {/* Profile image */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">Profile image (required)</label>
            <div className="flex items-center gap-4">
              <div className="h-20 w-20 overflow-hidden rounded-full border bg-neutral-50">
                {profilePreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={profilePreview}
                    alt="Profile preview"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-neutral-500">
                    Preview
                  </div>
                )}
              </div>
              <input
                    id="profileFile"
                    type="file"
                    accept="image/*"
                    onChange={onPickProfile}
                    className="hidden"
                  />
                  <label
                    htmlFor="profileFile"
                    className="cursor-pointer rounded-xl border bg-black px-4 py-2 text-sm text-white"
                  >
                    Choose File
                  </label>
            </div>
          </div>

          {/* Gallery upload */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">
              Back-of-card gallery (4 photos required)
            </label>
            <input
                ref={galleryInputRef}
                id="galleryFiles"
                type="file"
                accept="image/*"
                multiple
                onChange={onPickGallery}
                className="hidden"
              />
              <label
                htmlFor="galleryFiles"
                className="inline-block cursor-pointer rounded-xl border bg-black px-4 py-2 text-sm text-white"
              >
                Choose Files
              </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {Array.from({ length: Math.max(4, galleryPreviews.length) }).map((_, i) => {
                const preview = galleryPreviews[i];
                return (
                  <div
                    key={i}
                    className="relative aspect-square overflow-hidden rounded-xl border bg-neutral-50"
                  >
                    {preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={preview}
                        alt={`Gallery ${i + 1}`}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-neutral-500">
                        {i < 4 ? "Required" : "Extra"}
                      </div>
                    )}
                    {preview && (
                      <div className="absolute inset-x-1 bottom-1 flex items-center justify-between gap-1">
                        <button
                          onClick={() => moveGallery(i, i - 1)}
                          className="cursor-pointer rounded bg-white/80 px-2 py-1 text-[10px] shadow"
                        >
                          ←
                        </button>
                        <button
                          onClick={() => removeGalleryAt(i)}
                          className="cursor-pointer rounded bg-white/80 px-2 py-1 text-[10px] shadow"
                        >
                          Remove
                        </button>
                        <button
                          onClick={() => moveGallery(i, i + 1)}
                          className="cursor-pointer rounded bg-white/80 px-2 py-1 text-[10px] shadow"
                        >
                          →
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="text-xs text-neutral-600">
              Tip: Pick four photos that represent your style. Reorder with arrows.
            </div>
          </div>

          {/* Categories */}
          <div className="space-y-2">
            <div className="text-sm font-medium">Categories</div>
            <div className="flex flex-wrap gap-2">
              {allCats.map((c) => (
                <button
                  key={c.id}
                  onClick={() => toggleCategory(c.id)}
                  className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${
                    categories.includes(c.id) ? "bg-black text-white" : "hover:bg-neutral-100"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          {saveError && <div className="text-sm text-red-600">{saveError}</div>}

          <div className="flex gap-2">
            <button
              onClick={saveProfile}
              disabled={saving}
              className="cursor-pointer rounded-xl bg-black px-4 py-2 text-white disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving ? "Saving…" : "Save Profile"}
            </button>
          </div>
        </section>

        {/* Step 2: Stripe */}
        <section className="rounded-2xl border bg-white p-4 text-black space-y-4">
          <header className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">2) Connect Stripe</h2>
            {status?.stripeConnected ? (
              <span className="text-green-700 text-sm">Connected ✓</span>
            ) : (
              <span className="text-orange-700 text-sm">Not connected</span>
            )}
          </header>
          <p className="text-sm text-neutral-700">
            Payouts are handled via Stripe. You’ll be redirected to finish onboarding.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={connectStripe} className="cursor-pointer rounded-xl border px-4 py-2 text-sm">
              Connect Stripe
            </button>
            <button
              onClick={syncStripeNow}
              disabled={syncingStripe}
              className="cursor-pointer rounded-xl border px-3 py-2 text-xs disabled:opacity-60"
              title="If Stripe just finished enabling your account, click to refresh status."
            >
              {syncingStripe ? "Syncing…" : "Sync status"}
            </button>
          </div>
        </section>

        {/* Step 3: First Product */}
        <section className="rounded-2xl border bg-white p-4 text-black space-y-4">
          <header className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">3) Create Your First Product</h2>
            {status?.hasPublishedProduct ? (
              <span className="text-green-700 text-sm">Published ✓</span>
            ) : (
              <span className="text-orange-700 text-sm">None published</span>
            )}
          </header>
          <p className="text-sm text-neutral-700">
            Once you publish your first product, your creator account will activate automatically and your dashboard/nav will update.
          </p>

          <div className="flex gap-2">
            <Link
              href="/dashboard/products/new?from=setup"
              onClick={onProductLinkClick}
              className={`rounded-xl px-4 py-2 text-sm ${
                readyForProduct
                  ? "bg-black text-white cursor-pointer"
                  : "bg-neutral-200 text-neutral-500 cursor-not-allowed"
              }`}
              aria-disabled={!readyForProduct}
            >
              Go to Product Creator
            </Link>
          </div>
          {!readyForProduct && (
            <p className="text-xs text-neutral-600">
              Tip: Complete profile and connect Stripe first to enable product creation.
            </p>
          )}
        </section>

        {/* Status footer */}
        <footer className="text-sm text-black">
          {status ? (
            <div>
              Status:{" "}
              <strong>
                {status.isActive ? "Active" : loadingStatus ? "Checking…" : "Pending (complete steps above)"}
              </strong>
            </div>
          ) : (
            <div>Loading status…</div>
          )}
        </footer>
      </main>
    </div>
  );
}