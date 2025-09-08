"use client";
import { useState } from "react";
import { Product } from "@/types/products";
import { formatUSD } from "@/lib/format";
import { useCart } from "@/components/cart/CartProvider";

function isErrorWithMessage(err: unknown): err is { message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  );
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (isErrorWithMessage(err)) return err.message;
  return "Something went wrong";
}

export default function ProductDetail({ product }: { product: Product }) {
  const { addItem } = useCart();
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function handleAdd() {
    setAdding(true);
    setMsg(null);
    try {
      await addItem({ productId: product.id, quantity: 1 });
      setMsg("Added to cart");
    } catch (err: unknown) {
      setMsg(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  const isMembership = product.productType === "membership";

  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
      <div className="overflow-hidden rounded-2xl border">
        {product.thumbnailUrl ? (
          <img src={product.thumbnailUrl} alt={product.title} className="w-full object-cover" />
        ) : (
          <div className="flex aspect-[4/3] w-full items-center justify-center bg-neutral-100">No image</div>
        )}
      </div>

      <div>
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{product.title}</h1>
        <p className="mt-2 text-neutral-700">{product.description || ""}</p>

        <div className="mt-6">
          <div className="text-2xl font-bold">{formatUSD(product.price)}</div>
          <button
            onClick={handleAdd}
            disabled={adding}
            className="mt-3 inline-flex items-center justify-center rounded-2xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-black/90 disabled:opacity-60"
          >
            {adding ? (isMembership ? "Joining..." : "Adding...") : isMembership ? "Join membership" : "Add to cart"}
          </button>
          {msg && <div className="mt-2 text-xs text-neutral-600">{msg}</div>}
        </div>
      </div>
    </div>
  );
}