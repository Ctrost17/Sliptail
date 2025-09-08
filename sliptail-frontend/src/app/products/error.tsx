"use client";
export default function ErrorProducts({ error }: { error: Error }) {
return (
<main className="mx-auto max-w-6xl px-4 py-10">
<div className="rounded-2xl border p-6 text-sm text-red-600">{error.message || "Failed to load products."}</div>
</main>
);
}