import type { Metadata } from "next";
import Link from "next/link";
import { Mail, ArrowRight, Users, ExternalLink } from "lucide-react";

export const metadata: Metadata = {
  title: "Support • Sliptail",
  description:
    "Get help with Sliptail. Contact support by email, or reach out about partnerships and collaborations via social.",
};

export default function SupportPage() {
  return (
    <div className="min-h-screen bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 text-black">
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-3xl font-bold">Support</h1>
          <p className="mt-2">
            We’re here to help. Choose the best way to reach us below.
          </p>
        </header>

        {/* Content */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Email Support Card */}
          <section className="rounded-2xl bg-white shadow-sm p-6 sm:p-8">
            <div className="flex items-start gap-4">
              <div className="h-12 w-12 shrink-0 rounded-xl bg-green-50 text-green-700 flex items-center justify-center">
                <Mail className="h-6 w-6" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold">Email Support</h2>
                <p className="mt-1">
                  For account, billing, downloads, membership access, or request-related issues,
                  email us and we’ll get back within 24–48 hours.
                </p>

                <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:gap-3">
                  <a
                    href="mailto:info@sliptail.com?subject=Sliptail%20Support%20Request"
                    className="inline-flex items-center justify-center rounded-2xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-black/90"
                  >
                    Send email
                    <ArrowRight className="ml-1.5 h-4 w-4" />
                  </a>

                  <p className="mt-3 sm:mt-0 text-sm">
                    Or click the address:{" "}
                    <a
                      href="mailto:info@sliptail.com"
                      className="font-medium underline underline-offset-2"
                    >
                      info@sliptail.com
                    </a>
                  </p>
                </div>

                {/* Helpful details */}
                <ul className="mt-6 grid gap-2 text-sm">
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-gray-300" />
                    Include your account email and order ID (if applicable).
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-gray-300" />
                    Describe the issue and any steps to reproduce it.
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-gray-300" />
                    Attach screenshots or files if they help explain the problem.
                  </li>
                </ul>
              </div>
            </div>
          </section>

          {/* Partnerships / Collabs Card */}
          <section className="rounded-2xl bg-white shadow-sm p-6 sm:p-8">
            <div className="flex items-start gap-4">
              <div className="h-12 w-12 shrink-0 rounded-xl bg-sky-50 text-sky-700 flex items-center justify-center">
                <Users className="h-6 w-6" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold">
                  Partnerships &amp; Collaborations
                </h2>
                <p className="mt-1">
                  Interested in partnering or collaborating? Reach out via our social channels.
                </p>

                <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {/* X (Twitter) */}
                  <a
                    href="https://x.com/sliptail_"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-2xl border px-4 py-2 text-sm font-semibold hover:bg-neutral-100"
                    aria-label="Open Sliptail on X"
                  >
                    X
                    <ExternalLink className="ml-1.5 h-4 w-4" />
                  </a>

                  {/* Instagram */}
                  <a
                    href="https://instagram.com/sliptail_"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-2xl border px-4 py-2 text-sm font-semibold hover:bg-neutral-100"
                    aria-label="Open Sliptail on Instagram"
                  >
                    Instagram
                    <ExternalLink className="ml-1.5 h-4 w-4" />
                  </a>

                  {/* TikTok */}
                  <a
                    href="https://tiktok.com/@sliptail_"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-2xl border px-4 py-2 text-sm font-semibold hover:bg-neutral-100"
                    aria-label="Open Sliptail on TikTok"
                  >
                    TikTok
                    <ExternalLink className="ml-1.5 h-4 w-4" />
                  </a>
                </div>

                <p className="mt-4 text-xs">
                  Prefer email for partnerships? You can also contact{" "}
                  <a
                    href="mailto:info@sliptail.com?subject=Partnership%20Inquiry"
                    className="font-medium underline underline-offset-2"
                  >
                    info@sliptail.com
                  </a>
                  .
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* Quick help */}
        <section className="mt-8 rounded-2xl bg-white shadow-sm p-6 sm:p-8">
          <h3 className="text-base font-semibold">Quick help</h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
            <SupportLink label="Billing & refunds" />
            <SupportLink label="Account & login" />
            <SupportLink label="Membership access" />
            <SupportLink label="Downloads & files" />
            <SupportLink label="Custom requests" />
            <SupportLink label="Creator support" />
          </div>
          <p className="mt-4 text-xs">
            Clicking a topic will open your email client with a pre-filled subject line.
          </p>
        </section>
      </div>
    </div>
  );
}

function SupportLink({ label }: { label: string }) {
  const subject = encodeURIComponent(`Support: ${label}`);
  return (
    <Link
      href={`mailto:info@sliptail.com?subject=${subject}`}
      className="inline-flex items-center justify-between rounded-xl border px-3 py-2 hover:bg-neutral-50"
    >
      <span>{label}</span>
      <ArrowRight className="h-4 w-4" />
    </Link>
  );
}
