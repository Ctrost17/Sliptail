export default function LoadingProducts() {
return (
<main className="mx-auto max-w-6xl px-4 py-10">
<div className="h-8 w-48 animate-pulse rounded bg-neutral-200" />
<div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
{Array.from({ length: 6 }).map((_, i) => (
<div key={i} className="h-64 animate-pulse rounded-2xl border bg-neutral-50" />
))}
</div>
</main>
);
}