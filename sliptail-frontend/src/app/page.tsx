"use client";

import Link from "next/link";
import { useEffect, useState, useRef, useCallback, Children } from "react";
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
  categories: { id: number; name: string; slug: string }[];
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

const API_BASE: string = (() => {
  const a = (process.env.NEXT_PUBLIC_API_BASE || "").replace(/\/$/, "");
  const b = (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/$/, "");
  return a || b || "";
})();

const api = (path: string) =>
  `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;

function normalizeFeatured(payload: FeaturedApiResponse): FeaturedApiCreator[] {
  return Array.isArray(payload) ? payload : payload.creators ?? [];
}

async function fetchFeatured(): Promise<FeaturedApiCreator[]> {
  const res = await fetch(api("/api/creators/featured"), {
    credentials: "include",
    next: { revalidate: 60 },
  }).catch(() => null);

  if (!res || !res.ok) return [];
  const payload: FeaturedApiResponse = await res.json();
  return normalizeFeatured(payload);
}

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
  const urls = [api("/api/categories?count=true"), api("/api/categories")];

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
      // fall through
    }
  }

  return [];
}

/* ---------------------- Product Types Section ---------------------- */

function ProductTypesSection() {
  const items = [
    {
      key: "memberships",
      title: "Memberships",
      blurb:
        "Creators build recurring clubs with perks. Fans get ongoing access and community.",
      creatorPoints: [
        "Simple post and manage",
        "Predictable monthly income",
      ],
      fanPoints: [
        "Early access & behind-the-scenes",
        "Cancel-anytime billing via Stripe",
      ],
      icon: (
        <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
          <defs>
            <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="50%" stopColor="#22d3ee" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>
          </defs>
          <rect x="6" y="10" width="36" height="28" rx="6" fill="url(#g1)" />
          <circle cx="24" cy="24" r="6" fill="white" />
        </svg>
      ),
    },
    {
      key: "downloads",
      title: "Digital Downloads",
      blurb:
        "Creators upload once and sell forever. Fans get instant delivery.",
      creatorPoints: [
        "PDFs, videos, audio files, and more",
        "Automatic fulfillment after purchase",
      ],
      fanPoints: [
        "Instant access after checkout",
        "Re-download anytime from your My Purchases page",
      ],
      icon: (
        <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
          <defs>
            <linearGradient id="g2" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="50%" stopColor="#22d3ee" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>
          </defs>
          <path
            d="M14 10h20a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4z"
            fill="url(#g2)"
          />
          <path
            d="M24 14v12m0 0l-5-5m5 5l5-5M16 34h16"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      ),
    },
    {
      key: "custom",
      title: "Custom Requests",
      blurb:
        "Creators take bespoke commissions. Fans ask for exactly what they want.",
      creatorPoints: [
        "Built-in brief & Details",
        "Allows for any type of request",
      ],
      fanPoints: [
        "Attach references & specifics",
        "Clear status and easy Access to delivered work",
      ],
      icon: (
        <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
          <defs>
            <linearGradient id="g3" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="50%" stopColor="#22d3ee" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>
          </defs>
          <path d="M8 12h24l8 8v16a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V16a4 4 0 0 1 4-4z" fill="url(#g3)" />
          <path d="M32 12v8h8" fill="none" stroke="white" strokeWidth="2.5" />
          <path d="M14 30h20M14 24h10" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      key: "oneoff",
      title: "One-Time Purchases",
      blurb:
        "Creators run quick one-time content without subscriptions. Fans buy exactly what they want.",
      creatorPoints: ["Lifetime access", "Digital Downloads"],
      fanPoints: ["No commitment required", "Keep forever in your My Purcahses Page"],
      icon: (
        <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
          <defs>
            <linearGradient id="g6" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="50%" stopColor="#22d3ee" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="24" r="10" fill="url(#g6)" />
          <circle cx="32" cy="24" r="10" fill="url(#g6)" opacity="0.7" />
        </svg>
      ),
    },
  ];

  const Check = () => (
    <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
      <path
        d="M16.7 5.7a1 1 0 0 1 0 1.4l-7.2 7.2a1 1 0 0 1-1.4 0L3.3 9.6a1 1 0 1 1 1.4-1.4l3.6 3.6 6.5-6.5a1 1 0 0 1 1.4 0z"
        fill="currentColor"
      />
    </svg>
  );

  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <h2 className="relative mb-4 text-center text-3xl sm:text-4xl font-bold text-black">
        What You Can Buy & Sell on Sliptail
        <span className="pointer-events-none absolute -bottom-2 left-1/2 h-1 w-48 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-sky-500"></span>
      </h2>
      <p className="mx-auto mb-10 max-w-3xl text-center text-sm sm:text-base text-neutral-700">
        Whether you’re a <strong>creator</strong> launching your next revenue stream or a{" "}
        <strong>fan</strong> discovering new favorites—you’ll find flexible ways to support and get value.
      </p>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-2">
        {items.map((it) => (
          <div
            key={it.key}
            className="group relative rounded-2xl border border-black/10 bg-white p-6 shadow-sm transition hover:shadow-md"
          >
            <div className="mb-4 inline-flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-xl ring-1 ring-black/10 shadow bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400">
                {it.icon}
              </div>
              <h3 className="text-lg font-semibold text-black">{it.title}</h3>
            </div>

            <p className="mb-4 text-sm text-neutral-700">{it.blurb}</p>

            <div className="grid grid-cols-1 gap-3 text-sm">
              <div>
                <div className="mb-1 font-semibold">For creators</div>
                <ul className="space-y-1 text-neutral-700">
                  {it.creatorPoints.map((p, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="mt-[2px] text-emerald-500">
                        <Check />
                      </span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="mb-1 mt-2 font-semibold">For fans</div>
                <ul className="space-y-1 text-neutral-700">
                  {it.fanPoints.map((p, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="mt-[2px] text-sky-500">
                        <Check />
                      </span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ))}
      </div>
      {/* Removed: micro-CTAs (buttons) beneath the grid as requested */}
    </section>
  );
}

/* --------------------------------- Page --------------------------------- */

/** Mobile-only carousel: centers one card; arrows only if another card exists off-screen */
function FeaturedCarousel({ children }: { children: React.ReactNode }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [pad, setPad] = useState(0);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const getCards = useCallback(() => {
    const el = trackRef.current;
    return el ? el.querySelectorAll<HTMLElement>('[data-card="1"]') : ([] as any);
  }, []);

  const getCenteredIndex = useCallback(() => {
    const el = trackRef.current;
    const cards = getCards();
    if (!el || !cards.length) return -1;
    const cx = el.scrollLeft + el.clientWidth / 2;
    let best = 0, bestDist = Number.POSITIVE_INFINITY;
    cards.forEach((n, i) => {
      const mid = n.offsetLeft + n.offsetWidth / 2;
      const d = Math.abs(mid - cx);
      if (d < bestDist) { best = i; bestDist = d; }
    });
    return best;
  }, [getCards]);

  const centerIndex = useCallback((idx: number, behavior: ScrollBehavior) => {
    const el = trackRef.current;
    const cards = getCards();
    if (!el || !cards.length) return;
    const i = Math.max(0, Math.min(idx, cards.length - 1));
    const n = cards[i];
    const left = n.offsetLeft + n.offsetWidth / 2 - el.clientWidth / 2;
    el.scrollTo({ left, behavior });
  }, [getCards]);

  const update = useCallback(() => {
    const el = trackRef.current;
    const cards = getCards();
    if (!el || !cards.length) { setPad(0); setCanLeft(false); setCanRight(false); return; }

    // spacer so first/last can center (not used for single-card case below)
    const first = cards[0];
    // Ensure better centering by accounting for card width and container width
    const cardWidth = first.offsetWidth;
    const containerWidth = el.clientWidth;
    setPad(Math.max(0, (containerWidth - cardWidth) / 2));

    const idx = getCenteredIndex();
    setCanLeft(idx > 0);
    setCanRight(idx >= 0 && idx < cards.length - 1);
  }, [getCards, getCenteredIndex]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;

    const onScroll = () => update();
    el.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    const firstCard = getCards()[0];
    if (firstCard) ro.observe(firstCard);

    update();
    const i = getCenteredIndex();
    if (i >= 0) centerIndex(i, "auto");

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [centerIndex, getCards, getCenteredIndex, update]);

  const go = (dir: "left" | "right") => {
    const idx = getCenteredIndex();
    if (idx < 0) return;
    centerIndex(dir === "left" ? idx - 1 : idx + 1, "smooth");
  };

  // NEW: detect single-card layout and hard-center it (no spacers)
  const isSingle = Children.count(children) <= 1;

  return (
    // NEW: overflow-visible + extra bottom space so shadows never get clipped
    <div className="relative -mx-6 overflow-visible">
      {canLeft && !isSingle && (
        <button
          type="button"
          aria-label="Previous"
          onClick={() => go("left")}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-white p-2 shadow border"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M12.5 15L7.5 10l5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
      {canRight && !isSingle && (
        <button
          type="button"
          aria-label="Next"
          onClick={() => go("right")}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-white p-2 shadow border"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M7.5 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}

      <div
        ref={trackRef}
        className={[
          "flex items-center snap-x snap-mandatory scroll-smooth",
          "overflow-x-auto overflow-y-visible",
          // ↑ keep overflow-y-visible, but give more bottom padding so the card's drop shadow can render fully
          "pt-6 pb-16 min-h-[24rem]",
          isSingle ? "justify-center" : "justify-start",
        ].join(" ")}
        style={{
          scrollbarWidth: "none",
          WebkitOverflowScrolling: "touch",
          // spacer padding only matters when there's more than one card
          scrollPaddingLeft: isSingle ? undefined : `${pad}px`,
          scrollPaddingRight: isSingle ? undefined : `${pad}px`,
        }}
      >
        <style>{`div::-webkit-scrollbar { display: none; }`}</style>

        {/* Spacers only when there’s more than one card */}
        {!isSingle && <div aria-hidden className="shrink-0" style={{ width: `${pad}px` }} />}
        {children}
        {!isSingle && <div aria-hidden className="shrink-0" style={{ width: `${pad}px` }} />}
      </div>
    </div>
  );
}


export default function Home() {
  const [featured, setFeatured] = useState<FeaturedApiCreator[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const { user, loading: authLoading } = useAuth();

  const StartSellingCTA = ({ children }: { children: React.ReactNode }) => {
    if (authLoading) {
      return (
        <StartSellingButton className="rounded-md bg-black px-8 py-3 font-semibold text-white shadow transition hover:scale-105">
          {children}
        </StartSellingButton>
      );
    }

    if (!user) {
      return (
        <StartSellingButton className="rounded-md bg-black px-8 py-3 font-semibold text-white shadow transition hover:scale-105">
          {children}
        </StartSellingButton>
      );
    }

    const isCreatorLike = user.role === "creator" || user.role === "admin";
    const href = isCreatorLike ? "/dashboard" : "/creator/setup";

    return (
      <Link
        href={href}
        className="rounded-md bg-black px-8 py-3 font-semibold text-white shadow transition hover:scale-105"
      >
        {children}
      </Link>
    );
  }

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
      <section className="relative overflow-hidden bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 text-black">
        <div className="mx-auto max-w-6xl px-6 py-24 text-center">
          <div className="mx-auto mb-6 w-40 animate-fade-in-up"></div>
          <h1 className="mb-4 text-5xl font-bold animate-fade-in-up [animation-delay:200ms]">
            Support and Create
          </h1>
          <p className="mx-auto mb-8 max-w-2xl text-lg animate-fade-in-up [animation-delay:400ms]">
            Sliptail helps creators provide memberships, digital downloads, and custom requests — all in one place.
          </p>
          <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
            <StartSellingCTA>For Creators: Start Selling</StartSellingCTA>

            <Link
              href="/creators"
              className="rounded-md border border-black px-8 py-3 font-semibold text-black bg-white transition hover:scale-105 "
            >
              For Fans: Explore Creators
            </Link>
          </div>
        </div>
      </section>

      {/* Featured Creators */}
<section className="bg-gray-50 py-16">
  <div className="mx-auto max-w-6xl px-6">
    <h2 className="relative mb-10 text-center text-4xl font-bold text-black">
      Featured Creators
      <span className="pointer-events-none absolute -bottom-2 left-1/2 h-1 w-48 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-sky-500"></span>
    </h2>

    {/* Desktop/laptop: keep the grid */}
    {loading ? (
      <div className="hidden md:grid justify-items-center gap-6 sm:grid-cols-2 md:grid-cols-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-64 w-full max-w-sm animate-pulse rounded-2xl bg-white p-4 shadow" />
        ))}
      </div>
    ) : (
      <div className="hidden md:grid justify-items-center gap-6 sm:grid-cols-2 md:grid-cols-3">
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
              categories: c.categories ?? [],
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

    {/* Mobile: one-card centered carousel with arrows */}
    {loading ? (
      <div className="md:hidden">
        <FeaturedCarousel>
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              data-card="1"
              className="snap-center shrink-0 w-[100vw] flex justify-center"
            >
              <div className="h-64 w-full max-w-[280px] sm:max-w-[320px] rounded-2xl bg-white p-4 shadow animate-pulse" />
            </div>
          ))}
        </FeaturedCarousel>
      </div>
    ) : (
      <div className="md:hidden">
        {featured.length === 0 ? (
          <div className="text-center text-sm text-neutral-600">No featured creators yet.</div>
        ) : (
          <FeaturedCarousel>
            {featured.map((c) => (
              <div
                key={c.creator_id}
                data-card="1"
                className="snap-center shrink-0 w-[100vw] flex justify-center"
              >
                <CreatorCard
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
                    categories: c.categories ?? [],
                  }}
                />
              </div>
            ))}
          </FeaturedCarousel>
        )}
      </div>
    )}
  </div>
</section>

      {/* Categories */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="relative mb-10 text-center text-3xl sm:text-4xl font-bold text-black">
          Explore by Category
          <span className="pointer-events-none absolute -bottom-2 left-1/2 h-1 w-48 -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-sky-500"></span>
        </h2>
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
                className="rounded-full border border-sky-500 px-5 py-2 capitalize text-sky-700 transition hover:bg-sky-50"
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

      {/* Product types / both audiences */}
      <ProductTypesSection />

      {/* CTA */}
      <section className="bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 py-20 text-center text-black">
        <h2 className="mb-4 text-4xl font-bold">Join Sliptail Today</h2>
        <p className="mx-auto mb-8 max-w-xl text-lg">
          Whether you’re a creator or a fan, Sliptail makes connecting simple,
          safe, and fun.
        </p>
        <StartSellingCTA>Get Started</StartSellingCTA>
      </section>
    </div>
  );
}
