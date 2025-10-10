// app/auth/verified/page.tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";

// keep bots away; this is just a handoff page
export const metadata: Metadata = {
  title: "Verified",
  robots: { index: false, follow: false },
};

// avoid static optimization so it always runs on request
export const dynamic = "force-dynamic";

export default function VerifiedPage() {
  // Optionally preserve a flag so your <Toast /> can show "Email verified!"
  redirect("/?verified=1");
}
