import Link from "next/link";
import Image from "next/image";

export default function Footer() {
  return (
    <footer className="mt-auto border-t border-black/10 bg-neutral-800 text-neutral-100">
      {/* Optional accent bar (uncomment to enable) */}
      {/* <div className="h-1 bg-gradient-to-r from-emerald-400 via-cyan-400 to-sky-500" /> */}

      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
        {/* Links */}
        <div className="flex gap-8">
          <Link
            href="/support"
            className="text-xl font-medium text-white transition-colors"
          >
            Support
          </Link>
          <Link
            href="/about"
            className="text-xl font-medium text-white transition-colors"
          >
            About
          </Link>
        </div>

        {/* Social icons */}
        <div className="flex items-center gap-6">
          <a
            href="https://www.instagram.com/sliptail_/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Instagram"
            className="transition transform hover:scale-110"
          >
            <Image
              src="/icons/instaicon.png"
              alt="Instagram"
              width={36}
              height={36}
              className="h-9 w-9 rounded-md"
            />
          </a>

          <a
            href="https://x.com/Sliptail_"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="X (Twitter)"
            className="transition transform hover:scale-110"
          >
            <Image
              src="/icons/xicon.png"
              alt="X (Twitter)"
              width={36}
              height={36}
              className="h-9 w-9 rounded-md"
            />
          </a>

          <a
            href="https://www.tiktok.com/@sliptail_"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="TikTok"
            className="transition transform hover:scale-110"
          >
            <Image
              src="/icons/tiktokicon.png"
              alt="TikTok"
              width={36}
              height={36}
              className="h-9 w-9 rounded-md"
            />
          </a>
        </div>
      </div>
    </footer>
  );
}