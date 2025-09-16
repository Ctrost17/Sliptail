import Image from "next/image";
import Link from "next/link";
import { useMemo } from "react";

interface Creator {
  id: string;
  displayName: string;
  avatar: string;
  bio: string;
  rating: number;
  photos: string[];
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
  console.log("Rendering CreatorCard for:", creator);
  
  return (
    <div className="group relative h-80 w-64 [perspective:1000px]">
      <div className="relative h-full w-full transition-transform duration-500 [transform-style:preserve-3d] group-hover:[transform:rotateY(180deg)]">
        {/* front */}
        <div className="absolute inset-0 flex flex-col items-center rounded border bg-white p-4 [backface-visibility:hidden]">
          <Image
            src={resolveImageUrl(creator.avatar, apiBase) || "/default-avatar.png"}
            alt={creator.displayName}
            width={80}
            height={80}
            className="mb-2 rounded-full"
          />
          <h3 className="font-semibold">{creator.displayName}</h3>
          <p className="text-center text-sm text-gray-600">{creator.bio}</p>
          <div className="mt-2 flex items-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-4 w-4 text-yellow-500"
            >
              <path d="M12 .587l3.668 7.431 8.2 1.193-5.934 5.787 1.402 8.168L12 18.896l-7.336 3.87 1.402-8.168L.132 9.211l8.2-1.193z" />
            </svg>
            <span className="ml-1 text-sm">{creator.rating.toFixed(1)}</span>
          </div>
        </div>
        {/* back */}
        <div className="absolute inset-0 grid grid-cols-2 gap-1 rounded border bg-white p-2 [transform:rotateY(180deg)] [backface-visibility:hidden]">
          {creator.photos.slice(0, 4).map((src, i) => (
            <Image
              key={i}
              src={resolveImageUrl(src, apiBase)  || "/placeholder-image.png"  }
              alt=""
              width={120}
              height={120}
              className="h-full w-full object-cover"
            />
          ))}
          <Link
            href={`/creators/${creator.id}`}
            className="col-span-2 mt-1 rounded bg-blue-600 py-1 text-center text-white"
          >
            View Profile
          </Link>
        </div>
      </div>
    </div>
  );
}
