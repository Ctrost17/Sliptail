// app/layout.tsx
import type { Metadata } from "next";
import { Suspense } from "react";
import "@/app/globals.css";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { AuthProvider } from "@/components/auth/AuthProvider";
import Toast from "@/components/Toast";

export const metadata: Metadata = {
  metadataBase: new URL("https://sliptail.com"),
  title: {
    default:
      "Sliptail – Creator Platform for Memberships, Downloads & Custom Requests",
    template: "%s | Sliptail",
  },
  description:
    "Sliptail helps creators sell memberships, digital downloads, and custom requests — all in one place, while keeping 96% of their earnings.",
  openGraph: {
    type: "website",
    url: "https://sliptail.com",
    siteName: "Sliptail",
    title: "Sliptail – Creator Platform",
    description:
      "Sliptail is a creator platform where creators sell memberships, digital downloads, and custom requests while keeping 96% of their earnings.",
    images: [
      {
        url: "https://sliptail.com/icon.png", // put your OG image here
        width: 1200,
        height: 630,
        alt: "Sliptail logo",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Sliptail – Creator Platform",
    description:
      "Sliptail helps creators sell memberships, downloads & custom requests — all in one place.",
    images: ["https://sliptail.com/icon.png"],
  },
  icons: {
    icon: "/icon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Tell Google that Sliptail is an Organization / platform, not a musician */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              "name": "Sliptail",
              "url": "https://sliptail.com",
              "logo": "https://sliptail.com/icon.png", // or your main logo file
              "description":
                "Sliptail is a creator platform where creators sell memberships, digital downloads, and custom requests.",
              "sameAs": [
                "https://www.instagram.com/sliptail_",
                "https://www.tiktok.com/@sliptail_",
              ],
            }),
          }}
        />
      </head>
      <body className="min-h-screen text-black">
        <div className="flex min-h-screen flex-col bg-white">
          <AuthProvider>
            <Navbar />
            <main className="flex-1">
              <Suspense fallback={null}>{children}</Suspense>
            </main>
            <Suspense fallback={null}>
              <Toast />
            </Suspense>
            <Footer />
          </AuthProvider>
        </div>
      </body>
    </html>
  );
}
