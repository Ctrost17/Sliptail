"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import CreatorCard from "@/components/CreatorCard";

/* -------------------------- Types -------------------------- */

type Category = { id: number; name: string; slug: string };
type Creator = {
  creator_id: number;
  display_name: string;
  bio: string | null;
  profile_image: string | null;
  gallery: string[];
  average_rating: number | string;
  products_count: number | string;
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
function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ----------------------------- Component ---------------------------- */

export default function CreatorsExplorePage() {
  const apiBase = useMemo(() => toApiBase(), []);
  const searchParams = useSearchParams();
  const router = useRouter();

  const [categories, setCategories] = useState<Category[]>([]);
  const [catsLoading, setCatsLoading] = useState(true);

  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);

  /* ---- Read categoryId from URL on first render (and when URL changes) ---- */
      useEffect(() => {
        // Prefer numeric id; allow slug fallback if provided
        const idParam = searchParams.get("categoryId");
        const slugParam = searchParams.get("categorySlug");

        if (idParam) {
          const parsed = Number(idParam);
          if (Number.isFinite(parsed) && parsed !== categoryId) {
            setCategoryId(parsed);
          }
        } else if (slugParam && categories.length) {
          const sp = slugParam.toLowerCase();
          const match = categories.find((c) => c.slug?.toLowerCase?.() === sp);
          if (match && match.id !== categoryId) setCategoryId(match.id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [searchParams, categories.length]);

  // Keep URL in sync when local state changes (nice for bookmarking/sharing)
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (categoryId == null) {
      params.delete("categoryId");
      params.delete("categorySlug");
    } else {
      params.set("categoryId", String(categoryId));
      const found = categories.find((c) => c.id === categoryId);
      if (found?.slug) params.set("categorySlug", found.slug);
    }
    const qs = params.toString();
    const next = qs ? `?${qs}` : "";
    const current = searchParams.toString() ? `?${searchParams.toString()}` : "";
    if (next !== current) {
      router.replace(`/creators${next}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, categories]);

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
        <h1 className="text-2xl font-bold">Explore Creators</h1>
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
          className="cursor-pointer rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white"
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
          className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${
            categoryId === null
              ? "bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 text-black border-transparent"
              : "hover:bg-neutral-100"
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
                className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${
                  active
                    ? "bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 text-black border-transparent"
                    : "hover:bg-neutral-100"
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
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 place-items-center">
          {creators.map((creator) => (
            <CreatorCard
              key={creator.creator_id}
              creator={{
                id: creator.creator_id,
                displayName: creator.display_name,
                avatar: creator.profile_image,
                bio: creator.bio ?? "",
                rating: creator.average_rating,
                photos: creator.gallery,
                categories: creator.categories,
              }}
            />
          ))}
        </div>
      )}
    </main>
  );
}

