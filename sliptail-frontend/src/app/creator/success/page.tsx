"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function CreatorSuccessPage() {
  const router = useRouter();

  useEffect(() => {
    // Lets nav flip immediately in this session
    localStorage.setItem("creatorSetupDone", "true");
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="rounded-2xl border p-8 text-center">
        <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
          <span className="text-2xl">✅</span>
        </div>
        <h1 className="text-2xl font-semibold">You’re officially a Creator!</h1>
        <p className="mt-2 text-neutral-600">
          Your first product has been created. You can finish setting up your creator space from your dashboard.
        </p>

        <div className="mt-6 flex items-center justify-center">
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="rounded-xl px-4 py-2 text-sm bg-black text-white"
          >
            Next → Dashboard
          </button>
        </div>
      </div>
    </main>
  );
}