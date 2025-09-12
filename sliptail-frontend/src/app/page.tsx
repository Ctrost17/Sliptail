"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import CreatorCard from "@/components/CreatorCard";
import StartSellingButton from "@/components/StartSellingButton";
import { useAuth } from "@/components/auth/AuthProvider";

/* ----------------------------- Types ----------------------------- */

type FeaturedApiCreator = {
  creator_id: number;
  display_name: string;
  bio: string | null;
  profile_image: string | null;
  average_rating: string | number | null;
  gallery?: string[] | null;
};
type FeaturedApiResponse =
  | { creators: FeaturedApiCreator[] }
  | FeaturedApiCreator[];

interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  active?: boolean;
  creators_count?: number;
}

/* --------------------------- API helpers --------------------------- */

/**
 * Build a browser-safe base. In the client, envs are injected at build time.
 * Supports either NEXT_PUBLIC_API_BASE or NEXT_PUBLIC_API_BASE_URL.
 * Falls back to relative '/api' so Next rewrites proxy to your Express API.
 */
const API_BASE: string = (() => {
  const a = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");
  const b = (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/$/, "");
  return a || b || ""; // when empty, we’ll prefix paths with '/api/...'
})();

const api = (path: string) =>
  `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;

/** Normalize featured creators payload */
function normalizeFeatured(payload: FeaturedApiResponse): FeaturedApiCreator[] {
  return Array.isArray(payload) ? payload : payload.creators ?? [];
}

async function fetchFeatured(): Promise<FeaturedApiCreator[]> {
  // Public endpoint; no auth needed. Keep credentials optional-safe.
  const res = await fetch(api("/api/creators/featured"), {
    credentials: "include",
    // Cache a bit so home loads snappy; adjust if you want fully fresh
    next: { revalidate: 60 },
  }).catch(() => null);

  if (!res || !res.ok) return [];
  const payload: FeaturedApiResponse = await res.json();
  return normalizeFeatured(payload);
}

/** Normalize category array safely */
function normalizeCategoryArray(payload: unknown): CategoryRow[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (r): r is CategoryRow =>
        typeof r === "object" && r !== null && "id" in r && "name" in r
    );
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.categories)) return normalizeCategoryArray(obj.categories);
    if (Array.isArray(obj.data)) return normalizeCategoryArray(obj.data);
  }
  return [];
}

async function fetchCategories(): Promise<CategoryRow[]> {
  // Try the richer endpoint first (with counts), then fallback.
  const urls = [
    api("/api/categories?count=true"),
    api("/api/categories"),
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        credentials: "include",
        next: { revalidate: 300 },
      });
      if (!res.ok) continue;
      const payload: unknown = await res.json();
      const rows = normalizeCategoryArray(payload).filter((r) =>
        r.active === false ? false : true
      );
      if (rows.length) return rows;
    } catch {
      // try next URL
    }
  }

  return [];
}

/* --------------------------------- Page --------------------------------- */

export default function Home() {
  const [featured, setFeatured] = useState<FeaturedApiCreator[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const { user, loading: authLoading } = useAuth();

  // Helper: render the Start Selling CTA with routing override for signed-in users
  const StartSellingCTA = ({ children }: { children: React.ReactNode }) => {
    if (authLoading) {
      return (
        <StartSellingButton className="rounded-md bg-white px-8 py-3 font-semibold text-green-700 shadow transition hover:scale-105">
          {children}
        </StartSellingButton>
      );
    }

    if (!user) {
      return (
        <StartSellingButton className="rounded-md bg-white px-8 py-3 font-semibold text-green-700 shadow transition hover:scale-105">
          {children}
        </StartSellingButton>
      );
    }

    const isCreatorLike = user.role === "creator" || user.role === "admin";
    const href = isCreatorLike ? "/dashboard" : "/creator/setup";

    return (
      <Link
        href={href}
        className="rounded-md bg-white px-8 py-3 font-semibold text-green-700 shadow transition hover:scale-105"
      >
        {children}
      </Link>
    );
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [feat, cats] = await Promise.all([fetchFeatured(), fetchCategories()]);
        if (!cancelled) {
          setFeatured(feat);
          setCategories(cats);
        }
      } catch {
        if (!cancelled) {
          setFeatured([]);
          setCategories([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="font-sans">
      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-r from-green-400 to-green-600 text-white">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center">
          <div className="mx-auto mb-6 w-40 animate-fade-in-up">
            <Image src="/sliptail-logo.png" alt="Sliptail" width={160} height={50} />
          </div>
          <h1 className="mb-4 text-5xl font-bold animate-fade-in-up [animation-delay:200ms]">
            Support and Create
          </h1>
          <p className="mx-auto mb-8 max-w-2xl text-lg animate-fade-in-up [animation-delay:400ms]">
            Sliptail helps creators provide memberships, digital downloads, and custom requests — all in one place.
          </p>
          <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
            {/* Only the routing behavior of this button changes based on auth/role */}
            <StartSellingCTA>For Creators: Start Selling</StartSellingCTA>

            <Link
              href="/creators"
              className="rounded-md border border-white px-8 py-3 font-semibold text-white transition hover:scale-105 hover:bg-white/20"
            >
              For Fans: Explore Creators
            </Link>
          </div>
        </div>
      </section>

      {/* Featured Creators */}
      <section className="bg-gray-50 py-16">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="mb-8 text-center text-3xl font-bold">Featured Creators</h2>
          {loading ? (
            <div className="grid justify-items-center gap-6 sm:grid-cols-2 md:grid-cols-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-64 w-full max-w-sm animate-pulse rounded-2xl bg-white p-4 shadow" />
              ))}
            </div>
          ) : (
            <div className="grid justify-items-center gap-6 sm:grid-cols-2 md:grid-cols-3">
              {featured.map((c) => (
                <CreatorCard
                  key={c.creator_id}
                  creator={{
                    id: String(c.creator_id),
                    displayName: c.display_name,
                    avatar: c.profile_image ?? "",
                    bio: c.bio ?? "",
                    rating:
                      typeof c.average_rating === "string"
                        ? parseFloat(c.average_rating) || 0
                        : Number(c.average_rating || 0),
                    photos: (c.gallery ?? []).slice(0, 4),
                  }}
                />
              ))}
              {featured.length === 0 && (
                <div className="col-span-full text-center text-sm text-neutral-600">
                  No featured creators yet.
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Categories */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="mb-4 text-2xl font-bold">Explore by category</h2>
        {loading ? (
          <div className="flex flex-wrap gap-3">
            {[...Array(6)].map((_, i) => (
              <span key={i} className="h-9 w-28 animate-pulse rounded-full border border-green-200 bg-green-50/50" />
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {categories.map((cat) => (
              <a
                key={cat.id}
                href={`/creators?categoryId=${encodeURIComponent(cat.id)}`}
                className="rounded-full border border-green-500 px-5 py-2 capitalize text-green-700 transition hover:bg-green-50"
                title={
                  typeof cat.creators_count === "number"
                    ? `${cat.creators_count} creators`
                    : undefined
                }
              >
                {cat.name}
              </a>
            ))}
            {categories.length === 0 && (
              <div className="text-sm text-neutral-600">No categories yet.</div>
            )}
          </div>
        )}
      </section>

      {/* CTA */}
      <section className="bg-gradient-to-r from-green-500 to-green-700 py-20 text-center text-white">
        <h2 className="mb-4 text-4xl font-bold">Join Sliptail today</h2>
        <p className="mx-auto mb-8 max-w-xl text-lg">
          Whether you’re a creator or a fan, Sliptail makes connecting simple,
          safe, and fun.
        </p>
        {/* Bottom button shares the same smart routing */}
        <StartSellingCTA>Get Started</StartSellingCTA>
      </section>
    </div>
  );
}
