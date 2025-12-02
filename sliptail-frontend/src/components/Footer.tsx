"use client";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef } from "react";
import { useAgencyConfig } from "@/hooks/useAgencyConfig";

export default function Footer() {
  const ref = useRef<HTMLElement | null>(null);

  const agency = useAgencyConfig();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const setVar = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      document.documentElement.style.setProperty("--overscroll-bottom-band", `${h}px`);
    };

    setVar();

    // Update if the footer wraps or fonts load differently
    const ro = new ResizeObserver(setVar);
    ro.observe(el);

    // Re-run on orientation changes (iOS)
    window.addEventListener("orientationchange", setVar);

    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", setVar);
    };
  }, []);

  return (
    <footer
      ref={ref}
      className="mt-auto border-t border-black/10 bg-neutral-800 text-neutral-100"
    >
      {/* Optional accent bar (uncomment to enable) */}
      {/* <div className="h-1 bg-gradient-to-r from-emerald-400 via-cyan-400 to-sky-500" /> */}

      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
        {/* Links */}
          <div className="flex gap-8">
            <Link
              href={agency?.supportUrl || "/support"}
              className="text-l font-medium text-white transition-colors"
            >
              Support
            </Link>

            {agency?.isSliptail && (
              <Link href="/about" className="text-l font-medium text-white transition-colors">
                About
              </Link>
            )}

            <Link
              href={agency?.termsUrl || "/terms"}
              className="text-l font-medium text-white transition-colors"
            >
              Terms of Use
            </Link>
          </div>
        {/* Social icons */}
        {agency?.isSliptail && (
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
        </div>)}
      </div>
    </footer>
  );
}
