// src/app/creators/[id]/layout.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function CreatorRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // No wrapper UI needed; just pass through
  return <>{children}</>;
}