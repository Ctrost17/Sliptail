import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

interface Creator {
  id: number | string;
  displayName: string;
  avatar: string | null | undefined;
  bio: string;
  rating: number | string | null | undefined;
  photos: Array<string | null | undefined>;
  categories?: Array<string | { name: string } | { id: number; name: string; slug?: string }>;
}

function resolveImageUrl(src: string | null | undefined, apiBase: string): string | null {
  if (!src) return null;
  let s = src.trim();
  if (s.startsWith("//")) s = s.slice(1);
  if (/^https?:\/\//i.test(s)) return s;
  if (!s.startsWith("/")) s = `/${s}`;
  return `${apiBase}${s}`;
}
function toApiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");
}

export default function CreatorCard({ creator }: { creator: Creator }) {
  const apiBase = useMemo(() => toApiBase(), []);

  const ratingValue = useMemo(() => {
    const n = Number(creator.rating);
    return Number.isFinite(n) ? n : 0;
  }, [creator.rating]);

  const categoryNames = useMemo(() => {
    const arr = Array.isArray(creator.categories) ? creator.categories : [];
    return arr
      .map((c: any) => (typeof c === "string" ? c : c?.name || ""))
      .filter(Boolean)
      .slice(0, 4);
  }, [creator.categories]);

  const avatarSrc = resolveImageUrl(creator.avatar, apiBase) || "/default-avatar.png";
  const photoSrcs = (creator.photos || [])
    .slice(0, 4)
    .map((src) => resolveImageUrl(src || null, apiBase) || "/placeholder-image.png");

  // --- Mobile tap-to-flip support ---
  const [isCoarse, setIsCoarse] = useState(false);  // true on touch / coarse pointers
  const [isFlipped, setIsFlipped] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(pointer: coarse)");
    const apply = () => setIsCoarse(!!mq.matches);
    apply();
    try {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    } catch {
      // Safari <14 fallback
      mq.addListener?.(apply);
      return () => mq.removeListener?.(apply);
    }
  }, []);

  function toggleFlip() {
    if (isCoarse) setIsFlipped((f) => !f);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Allow keyboard toggle for accessibility
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setIsFlipped((f) => !f);
    }
  }

  return (
    <div
      className={`group relative h-80 w-64 [perspective:1000px] ${isCoarse ? "cursor-pointer" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={isFlipped}
      onClick={toggleFlip}
      onKeyDown={onKeyDown}
    >
      <div
        className={
          "relative h-full w-full rounded-2xl shadow-2xl shadow-black/25 transition-transform duration-500 " +
          "[transform-style:preserve-3d] " +
          // Flip on hover (desktop) and when state says so (mobile/keyboard)
          (isFlipped ? "[transform:rotateY(180deg)] " : "") +
          "group-hover:[transform:rotateY(180deg)]"
        }
      >
        {/* front */}
        <div
          className="absolute inset-0 flex flex-col items-center rounded-2xl p-4 [backface-visibility:hidden]
            bg-white/10 border-2 border-black backdrop-blur-xl text-black"
        >
          <Image
            src={avatarSrc}
            alt={creator.displayName}
            width={80}
            height={80}
            className="mb-2 rounded-full object-cover"
          />
          <h3 className="font-semibold text-black tracking-tight truncate max-w-full">
            {creator.displayName}
          </h3>

          {categoryNames.length > 0 && (
            <div className="mt-1 mb-0 h-6 overflow-hidden flex flex-nowrap items-center justify-center gap-1">
              {categoryNames.map((c, i) => (
                <span
                  key={`${c}-${i}`}
                  className="px-2 py-0.5 text-xs font-medium rounded-full border border-black/20 bg-white/70 backdrop-blur-sm whitespace-nowrap"
                >
                  {c}
                </span>
              ))}
            </div>
          )}
          <div className="mt-1 h-5 flex items-center text-black/90">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-4 w-4 text-amber-300"
              aria-hidden="true"
            >
              <path d="M12 .587l3.668 7.431 8.2 1.193-5.934 5.787 1.402 8.168L12 18.896l-7.336 3.87 1.402-8.168L.132 9.211l8.2-1.193z" />
            </svg>
            <span className="ml-1 text-sm text-black/90">{ratingValue.toFixed(1)}</span>
          </div>

          <p className="mt-3 text-center text-sm text-black/80 line-clamp-3">
            {creator.bio}
          </p>
        </div>

        {/* back */}
        <div
          className="absolute inset-0 grid grid-rows-[1fr_auto] gap-2 rounded-2xl p-2 [transform:rotateY(180deg)] [backface-visibility:hidden]
            bg-white/10 border-2 border-black backdrop-blur-xl"
        >
          {/* photos area fills */}
          <div className="grid grid-cols-2 gap-2 h-full min-h-0">
            {photoSrcs.map((src, i) => (
              <div key={i} className="relative w-full h-full overflow-hidden rounded-lg border border-black/10">
                <Image src={src} alt="" fill className="object-cover" />
              </div>
            ))}
          </div>
          {/* button row; stop flip toggle when link is tapped/clicked */}
          <Link
            href={`/creators/${creator.id}`}
            className="rounded-xl border-2 border-black bg-black/10 py-2 text-center text-black hover:bg-white/15 transition"
            onClick={(e) => e.stopPropagation()}
          >
            View Profile
          </Link>
        </div>
      </div>
    </div>
  );
}