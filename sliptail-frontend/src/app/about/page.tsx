"use client";

import Image from "next/image";
import { useState } from "react";

/**
 * Sliptail – About Page
 * - Theme: gradient-to-r from-emerald-300 via-cyan-400 to-sky-400
 * - 5 sections: Summary(Hero), Pricing, Product Ideas, Sneak Peek, FAQ
 * - No CTAs/buttons; mission-forward copy
 */

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-white text-slate-800">
      <Hero />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Pricing />
        <ProductIdeas />
        <SneakPeek />
        <FAQ />
      </div>
      {/* No footer CTA by request */}
    </main>
  );
}

/* ---------------------------------- Hero --------------------------------- */
function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* brand gradient ribbon */}
      <div className="absolute inset-x-0 top-0 -z-10 h-60 bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 blur-[2px]" />
      {/* soft background blobs */}
      <div className="absolute inset-0 -z-10">
        <div className="pointer-events-none absolute -top-20 -left-24 h-72 w-72 rounded-full bg-emerald-200/40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-28 -right-28 h-80 w-80 rounded-full bg-sky-200/40 blur-3xl" />
      </div>

      <div className="mx-auto max-w-7xl px-4 pb-14 pt-24 sm:pb-20 sm:pt-28 lg:px-8">
        {/* removed: “Built for digital creators” bubble */}
        <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl md:text-6xl">
          A simpler way to earn from your audience
          <span className="block bg-gradient-to-r from-emerald-600 via-cyan-600 to-sky-600 bg-clip-text text-transparent">
            — sell products, memberships, and custom work.
          </span>
        </h1>
        <p className="mt-6 max-w-3xl text-lg leading-7 text-slate-700">
          Sliptail focuses on the essentials: smooth checkout, reliable delivery, clear access,
          and fast payouts—so creators can spend less time fiddling with tools and more time
          creating. Our mission is to make independent earning sustainable by keeping fees low,
          removing complexity, and giving buyers a clean, trustworthy experience.
        </p>

        {/* removed: Create account / Explore buttons */}
      </div>
    </section>
  );
}

/* -------------------------------- Pricing -------------------------------- */
function Pricing() {
  return (
    <section id="pricing" className="py-14 sm:py-20">
      <SectionHeader
        eyebrow="Pricing"
        title="Simple, transparent, creator-friendly"
        subtitle="We take a flat 4% platform fee. Your payment processor adds its standard card/Wallet fees. No monthly charges."
        bigEyebrow
      />

      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
          <div className="flex items-center gap-3">
            <Badge>Platform</Badge>
            <h3 className="text-2xl font-semibold">4% per transaction</h3>
          </div>
          <p className="mt-3 text-[15px] text-slate-700">
            Only pay when you earn. This funds hosting, secure delivery, access control, and ongoing development.
            <span className="ml-1 font-semibold text-emerald-700">
              Our fee is among the lowest of major creator platforms, so you keep more of what you make.
            </span>
          </p>
          <ul className="mt-5 space-y-2.5 text-[15px] text-slate-800">
            <li className="flex items-start gap-2"><Check /> Secure delivery & access management</li>
            <li className="flex items-start gap-2"><Check /> Creator profile & storefront</li>
            <li className="flex items-start gap-2"><Check /> Reviews & light analytics</li>
          </ul>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
          <div className="flex items-center gap-3">
            <Badge>Processing</Badge>
            <h3 className="text-2xl font-semibold">Processor fees</h3>
          </div>
          <p className="mt-3 text-[15px] text-slate-700">
            Charged by your payment processor (e.g., Stripe). A common example is ~2.9% + $0.30 in the U.S.
            (varies by country/method).
          </p>
          <div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm">
            <p className="font-medium text-slate-900">Example on a $20 sale</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-slate-700">
              <div>Platform fee (4%)</div><div className="text-right">$0.80</div>
              <div>Processing (~2.9% + $0.30)</div><div className="text-right">~$0.88</div>
              <div className="font-semibold text-slate-900">Estimated payout</div>
              <div className="text-right font-semibold text-emerald-600">~$18.32</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------- Product Ideas ---------------------------- */
function ProductIdeas() {
  const groups: { title: string; items: string[] }[] = [
    { title: "Writers & Bloggers", items: ["Ebooks & premium newsletters", "Editorial calendars & prompts", "Swipe files & templates"] },
    { title: "Designers & Illustrators", items: ["UI kits, icons, fonts", "Figma/Notion templates", "Brand kits & mockups"] },
    { title: "Developers & Engineers", items: ["Starters & boilerplates", "Component libraries", "CLI tools & scripts"] },
    { title: "Musicians & Podcasters", items: ["Sample packs & stems", "Presets & loops", "Bonus episodes & BTS"] },
    { title: "Educators & Coaches", items: ["Mini-courses & lesson packs", "Workshop replays", "1:1 or group coaching via requests"] },
    { title: "Fitness & Wellness", items: ["Program PDFs & trackers", "Guided audio/video", "Weekly programming memberships"] },
    { title: "Photographers & Filmmakers", items: ["LUTs & presets", "Stock packs & project files", "Editing walkthroughs"] },
    { title: "Streamers & Creators", items: ["Overlay packs & emotes", "Transition packs", "Sponsorship kits & calendars"] },
  ];

  return (
    <section id="product-ideas" className="py-14 sm:py-20">
      <SectionHeader
        eyebrow="Ideas"
        title="What can you sell on Sliptail?"
        subtitle="One-time purchases, memberships for ongoing access, or paid custom requests. Start simple and iterate."
        bigEyebrow
      />

      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => (
          <div
            key={g.title}
            className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:shadow-md"
          >
            <div className="mb-3 flex items-center gap-2">
              <span className="inline-flex h-2 w-2 rounded-full bg-gradient-to-r from-emerald-500 via-cyan-500 to-sky-500" />
              <h3 className="text-lg font-semibold text-slate-900">{g.title}</h3>
            </div>
            <ul className="space-y-2 text-sm text-slate-700">
              {g.items.map((it) => (
                <li key={it} className="flex items-start gap-2"><Arrow />{it}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------ Sneak Peek ------------------------------ */
function SneakPeek() {
  return (
    <section id="sneak-peek" className="py-14 sm:py-20">
      <SectionHeader
        eyebrow="Sneak Peek"
        title="A clean experience for buyers and creators"
        subtitle="Buyers can access everything in one Purchases hub. Creators manage profiles and products from a simple dashboard."
        bigEyebrow
      />

      {/* 2 columns on lg; 3 cards: Purchases + Dashboard (2 parts) */}
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2">
        <ScreenshotCard
          title="My Purchases"
          subtitle="View, stream, or download your products in seconds."
          src="/mypurchases.png"
          alt="My Purchases page showing a grid of past purchases with quick actions"
        />

        <ScreenshotCard
          title="Creator Dashboard — Products"
          subtitle="Upload products, set pricing, and manage publishing."
          src="/dashboard-2.png"
          alt="Creator dashboard products management"
        />

        {/* NEW: second dashboard screenshot slot */}
        <ScreenshotCard
          title="Creator Dashboard — Profile & Complete Requests"
          subtitle="Customize your public profile and Complete Requests."
          src="/dashboard-1.png"
          alt="Creator dashboard profile and settings"
        />
      </div>
    </section>
  );
}

function ScreenshotCard({ title, subtitle, src, alt }: { title: string; subtitle: string; src: string; alt: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-4 border-b border-slate-200 p-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <p className="text-sm text-slate-600">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1">
          <WindowDot className="text-rose-400" />
          <WindowDot className="text-amber-400" />
          <WindowDot className="text-emerald-400" />
        </div>
      </div>
      <div className="relative aspect-[16/10] w-full bg-slate-50">
        <Image src={src} alt={alt} fill className="object-cover object-top" sizes="(min-width: 1024px) 50vw, 100vw" />
      </div>
    </div>
  );
}

/* ---------------------------------- FAQ --------------------------------- */
function FAQ() {
  // all answers hidden by default; replaced two topics per request
  const items: { q: string; a: string }[] = [
    {
      q: "How do fees work?",
      a: "We charge 4% per transaction, plus standard payment processing fees from your processor (e.g., Stripe). No monthly fees.",
    },
    {
      q: "Do I keep ownership of my content?",
      a: "Yes. You retain full ownership. Sliptail hosts and delivers your content to buyers under your terms.",
    },
    {
      q: "What file types can I sell?",
      a: "Common formats include MP4 video, MP3 audio, PDF/EPUB docs, images, ZIP bundles, and more. If buyers can download or view it, you can likely sell it.",
    },
    {
      q: "How do memberships work?",
      a: "Create a membership product and publish updates. Buyers with an active membership automatically get access.",
    },
    {
      q: "How do buyers access purchases?",
      a: "After checkout, buyers can access 'My Purchases' from the dropdown menu to stream, view, or download products.",
    },
    {
      q: "Why use this platform over others?",
      a: "Easier to use. Lower platfrom fees. More friendly terms. We focus on the essentials so you can focus on creating.",
    },
  ];

  return (
    <section id="faq" className="pb-8 pt-2 sm:pb-12">
      <SectionHeader eyebrow="FAQ" title="Frequently asked questions" bigEyebrow />
      <div className="mx-auto max-w-3xl divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {items.map((it, idx) => (
          <AccordionItem key={idx} question={it.q} answer={it.a} />
        ))}
      </div>
    </section>
  );
}

function AccordionItem({
  question,
  answer,
}: {
  question: string;
  answer: string;
}) {
  const [open, setOpen] = useState(false); // hidden by default
  return (
    <div className="px-5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 py-4 text-left hover:opacity-90"
        aria-expanded={open}
        aria-controls={question}
      >
        <span className="text-base font-semibold text-slate-900">{question}</span>
        <span
          className={`grid h-7 w-7 place-items-center rounded-lg border text-slate-700 transition ${
            open ? "rotate-45 bg-slate-50" : "bg-white"
          }`}
        >
          <Plus />
        </span>
      </button>
      {/* simple hidden/visible to avoid peeking text */}
      <div id={question} className={open ? "pb-5 pr-2 text-sm leading-6 text-slate-700" : "hidden"}>
        {answer}
      </div>
    </div>
  );
}

/* ---------------------------- Shared Components --------------------------- */
function SectionHeader({
  eyebrow,
  title,
  subtitle,
  bigEyebrow = false,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  bigEyebrow?: boolean;
}) {
  return (
    <header className="mx-auto mb-8 max-w-3xl text-center sm:mb-10">
      {eyebrow && (
        <div
          className={`mx-auto mb-3 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white ${
            bigEyebrow ? "px-4 py-2 text-sm" : "px-3 py-1 text-[11px]"
          } font-medium tracking-wide text-slate-700 shadow-sm`}
        >
          <Dot className="text-emerald-500" /> {eyebrow}
        </div>
      )}
      <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">{title}</h2>
      {subtitle && <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-600 sm:text-base">{subtitle}</p>}
    </header>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-800">
      {children}
    </span>
  );
}

/* ------------------------------ Tiny Icons ------------------------------ */
function Dot({ className = "" }) {
  return <span className={`inline-block h-2 w-2 rounded-full bg-current ${className}`} />;
}
function WindowDot({ className = "" }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full bg-current ${className}`} />;
}
function Check() {
  return (
    <svg
      className="mt-0.5 h-4 w-4 flex-none text-emerald-600"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
function Arrow() {
  return (
    <svg
      className="mt-0.5 h-4 w-4 flex-none text-slate-400"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}
function Plus() {
  return (
    <svg
      className="h-4 w-4 text-slate-700"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
