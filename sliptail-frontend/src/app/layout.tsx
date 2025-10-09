// app/layout.tsx
import type { Metadata } from "next";
import { Suspense } from "react";
import "@/app/globals.css";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { AuthProvider } from "@/components/auth/AuthProvider";
import Toast from "@/components/Toast";

export const metadata: Metadata = {
  // helps Next generate absolute URLs for meta tags
  metadataBase: new URL("https://sliptail.com"),

  title: "Sliptail",
  description:
    "Sliptail helps creators sell memberships, digital downloads, and custom requests — all in one place.",

  // favicon (place /public/favicon.ico in your repo)
  icons: {
    icon: "/icon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col bg-white text-black">
        {/* Wrap the entire app with AuthProvider so useAuth works anywhere */}
        <AuthProvider>
          <Navbar />
          <main className="flex-1">
            <Suspense fallback={null}>{children}</Suspense>
          </main>
          <Toast />
          <Footer />
        </AuthProvider>
      </body>
    </html>
  );
}