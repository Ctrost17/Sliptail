import type { Metadata } from "next";
import { Suspense } from "react";
import "@/app/globals.css";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { AuthProvider } from "@/components/auth/AuthProvider";
import Toast from "@/components/Toast";

export const metadata: Metadata = {
  title: "Sliptail",
  description: "Memberships, downloads, and custom requests for creators.",
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