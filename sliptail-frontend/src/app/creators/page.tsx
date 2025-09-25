"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";

/* -------------------------- Types -------------------------- */

type Category = { id: number; name: string; slug: string };
type Creator = {
  creator_id: number;
  display_name: string;
  bio: string | null;
  profile_image: string | null;
  gallery: string[];
  average_rating: number | string;   // ← allow string from PG numeric
  products_count: number | string;   // ← allow string from PG count
  categories: { id: number; name: string; slug: string }[];
};
type CreatorsResponse = { creators: Creator[] };
type CategoriesResponse = { categories: Category[] };

/* ----------------------------- Helpers ----------------------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function toApiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");
}
function resolveImageUrl(src: string | null | undefined, apiBase: string): string | null {
  if (!src) return null;
  let s = src.trim();
  if (s.startsWith("//")) s = s.slice(1);
  if (/^https?:\/\//i.test(s)) return s;
  if (!s.startsWith("/")) s = `/${s}`;
  return `${apiBase}${s}`;
}
function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ----------------------------- Component ---------------------------- */

export default function CreatorsExplorePage() {
  const apiBase = useMemo(() => toApiBase(), []);

  const [categories, setCategories] = useState<Category[]>([]);
  const [catsLoading, setCatsLoading] = useState(true);

  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);

  // Load categories
  useEffect(() => {
    const ac = new AbortController();
    setCatsLoading(true);
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/categories`, {
          credentials: "include",
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: unknown = await res.json();
        if (isRecord(data) && Array.isArray((data as CategoriesResponse).categories)) {
          setCategories((data as CategoriesResponse).categories);
        } else {
          setCategories([]);
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) setCategories([]);
      } finally {
        setCatsLoading(false);
      }
    })();
    return () => ac.abort();
  }, [apiBase]);

  // Load creators whenever query or category changes
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("q", query.trim());
        if (categoryId != null) params.set("categoryId", String(categoryId));

        const url = params.toString()
          ? `${apiBase}/api/creators?${params.toString()}`
          : `${apiBase}/api/creators`;

        const res = await fetch(url, { credentials: "include", signal: ac.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: unknown = await res.json();

        let list: Creator[] = [];
        if (isRecord(data) && Array.isArray((data as CreatorsResponse).creators)) {
          list = (data as CreatorsResponse).creators;
        }

        // ensure products_count is numeric for filtering
        setCreators(list.filter((cr) => toNumber(cr.products_count) > 0));
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setError("Failed to load creators");
          setCreators([]);
        }
      } finally {
        setLoading(false);
      }
    })();

    return () => ac.abort();
  }, [apiBase, query, categoryId]);

  function onSubmitSearch(e: React.FormEvent) {
    e.preventDefault();
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">Explore creators</h1>
        <p className="text-sm text-neutral-600">
          Discover active creators. Filter by category or search by name.
        </p>
      </header>

      {/* Search bar */}
      <form onSubmit={onSubmitSearch} className="flex items-center gap-2">
        <input
          aria-label="Search creators"
          placeholder="Search creators by name"
          className="w-full rounded-xl border px-3 py-2"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="submit"
          className="rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white"
        >
          Search
        </button>
      </form>

      {/* Category filter chips */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={categoryId === null}
          onClick={() => setCategoryId(null)}
          className={`rounded-full border px-3 py-1 text-sm ${
            categoryId === null ? "bg-black text-white border-black" : "hover:bg-neutral-100"
          }`}
        >
          All
        </button>

        {catsLoading ? (
          <span className="text-sm text-neutral-500">Loading categories…</span>
        ) : categories.length ? (
          categories.map((cat) => {
            const active = categoryId === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                aria-pressed={active}
                onClick={() => setCategoryId(active ? null : cat.id)}
                className={`rounded-full border px-3 py-1 text-sm ${
                  active ? "bg-black text-white border-black" : "hover:bg-neutral-100"
                }`}
                title={cat.name}
              >
                {cat.name}
              </button>
            );
          })
        ) : (
          <span className="text-sm text-neutral-500">No categories available.</span>
        )}
      </div>

      {/* Results */}
      {error && (
        <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-neutral-600">Loading creators…</div>
      ) : creators.length === 0 ? (
        <div className="text-sm text-neutral-600">No matching creators.</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {creators.map((creator) => {
            const profile = resolveImageUrl(creator.profile_image, apiBase);
            const gallery = (creator.gallery || [])
              .slice(0, 4)
              .map((u) => resolveImageUrl(u, apiBase))
              .filter((u): u is string => !!u);

            const ratingNum = toNumber(creator.average_rating);     // ← coerce to number
            const rating = ratingNum.toFixed(1);

            const productsCount = toNumber(creator.products_count); // ← coerce to number

            return (
              <div
                key={creator.creator_id}
                className="group relative h-64 rounded-2xl overflow-hidden transition hover:shadow-md"
                style={{ perspective: "1000px", isolation: "isolate" }}
              >
                {/* Flipper (border flips with content) */}
                <div
                  className="flip-inner relative h-full w-full rounded-2xl border transition-transform duration-500"
                  style={{
                    transformStyle: "preserve-3d",
                    WebkitTransformStyle: "preserve-3d",
                    willChange: "transform",
                    transformOrigin: "center center",
                    background: "transparent",
                  }}
                >
                  {/* FRONT face (transparent container) */}
                  <div
                    className="absolute inset-0 rounded-2xl"
                    style={{
                      transform: "rotateY(0deg) translateZ(0.01px)",
                      backfaceVisibility: "hidden",
                      WebkitBackfaceVisibility: "hidden",
                    }}
                  >
                    {/* inset white panel so border isn't covered */}
                    <div className="panel-front absolute inset-[1px] rounded-2xl bg-white p-4 transition-opacity duration-200 opacity-100 group-hover:opacity-0">
                      <div className="flex items-center gap-3">
                        <div className="relative h-12 w-12 overflow-hidden rounded-full bg-neutral-100">
                          {profile ? (
                            <Image
                              src={profile}
                              alt={creator.display_name}
                              fill
                              className="object-cover"
                              unoptimized
                              sizes="48px"
                            />
                          ) : null}
                        </div>
                        <div>
                          <div className="font-semibold">{creator.display_name}</div>
                          <div className="text-xs text-neutral-600">
                            {rating} ★ · {productsCount} product{productsCount === 1 ? "" : "s"}
                          </div>
                        </div>
                      </div>

                      {creator.categories?.length ? (
                        <div className="mt-3 flex flex-wrap gap-1">
                          {creator.categories.slice(0, 3).map((c) => (
                            <span
                              key={c.id}
                              className="rounded-full border px-2 py-0.5 text-xs text-neutral-700"
                            >
                              {c.name}
                            </span>
                          ))}
                          {creator.categories.length > 3 && (
                            <span className="text-xs text-neutral-500">
                              +{creator.categories.length - 3} more
                            </span>
                          )}
                        </div>
                      ) : null}

                      {creator.bio ? (
                        <p className="mt-3 line-clamp-4 text-sm text-neutral-700">
                          {creator.bio}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {/* BACK face (transparent container) */}
                  <div
                    className="absolute inset-0 rounded-2xl"
                    style={{
                      transform: "rotateY(180deg) translateZ(0.01px)",
                      backfaceVisibility: "hidden",
                      WebkitBackfaceVisibility: "hidden",
                    }}
                  >
                    {/* inset white panel; cross-fade in on hover */}
                    <div className="panel-back absolute inset-[1px] rounded-2xl bg-white p-3 transition-opacity duration-200 opacity-0 group-hover:opacity-100">
                      <div className="grid h-full grid-rows-[1fr_auto] gap-3">
                        <div className="grid grid-cols-2 grid-rows-2 gap-2">
                          {[0, 1, 2, 3].map((idx) => {
                            const src = gallery[idx];
                            return (
                              <div
                                key={idx}
                                className="relative h-full min-h-16 w-full overflow-hidden rounded-lg bg-neutral-100"
                              >
                                {src ? (
                                  <Image
                                    src={src}
                                    alt={`${creator.display_name} photo ${idx + 1}`}
                                    fill
                                    className="object-cover"
                                    unoptimized
                                    sizes="(max-width:768px) 33vw, 200px"
                                  />
                                ) : null}
                              </div>
                            );
                          })}
                        </div>

                        <div className="flex items-center justify-end">
                          <Link
                            href={`/creators/${creator.creator_id}`}
                            className="inline-flex items-center rounded-xl bg-black px-3 py-2 text-sm font-semibold text-white hover:bg-black/90"
                          >
                            View profile
                          </Link>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Flip interaction */}
                <style jsx>{`
                  .group:hover .flip-inner {
                    transform: rotateY(180deg) translateZ(0);
                  }
                `}</style>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
