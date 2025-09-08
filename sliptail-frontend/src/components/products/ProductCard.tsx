"use client";
import Link from "next/link";
import { Product } from "@/types/products";
import { formatUSD } from "@/lib/format";


export default function ProductCard({ product }: { product: Product }) {
const label =
product.productType === "purchase"
? "Digital Download"
: product.productType === "membership"
? "Membership"
: "Custom Request";


return (
<div className="group flex flex-col overflow-hidden rounded-2xl border shadow-sm">
<Link href={`/products/${product.id}`} className="aspect-[4/3] w-full overflow-hidden">
{product.thumbnailUrl ? (
<img
src={product.thumbnailUrl}
alt={product.title}
className="h-full w-full object-cover transition group-hover:scale-[1.02]"
/>
) : (
<div className="flex h-full w-full items-center justify-center bg-neutral-100">No image</div>
)}
</Link>
<div className="flex flex-1 flex-col gap-2 p-4">
<div className="flex items-center justify-between">
<div className="text-xs text-neutral-600">{label}</div>
<span className="text-sm font-semibold">{formatUSD(product.price)}</span>
</div>
<div className="text-base font-semibold leading-tight line-clamp-2">{product.title}</div>
<div className="mt-auto flex items-center justify-between">
<div className="text-xs text-neutral-600 line-clamp-2">{product.description}</div>
<Link href={`/products/${product.id}`} className="rounded-2xl border px-3 py-1.5 text-sm hover:bg-neutral-100">
{product.productType === "membership" ? "Join" : "View"}
</Link>
</div>
</div>
</div>
);
}