import { fetchApi } from "@/lib/api";
import ProductCard from "@/components/products/ProductCard";
import { Product } from "@/types/products";

export const dynamic = "force-dynamic"; // ensure fresh fetch in dev

export default async function ProductsPage() {
  // Cast to Product[] since we're not using raw:true in fetchApi
  const products = (await fetchApi<Product[]>("/api/products")) as Product[];

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Products</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Downloads, memberships, and custom requests.
          </p>
        </div>
      </div>

      {(!products || products.length === 0) ? (
        <div className="rounded-2xl border p-6 text-sm text-neutral-600">
          No products yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </main>
  );
}