"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

/** Types */
type ProductType = "purchase" | "membership" | "request";

/** Safe helpers */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function getStringProp(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}
function getNumberProp(obj: unknown, key: string): number | undefined {
  if (!isRecord(obj)) return undefined;
  const v = obj[key];
  return typeof v === "number" ? v : undefined;
}
function extractMessage(obj: unknown, fallback: string): string {
  return getStringProp(obj, "error") || getStringProp(obj, "message") || fallback;
}

/** Local auth loader */
function loadAuthSafe(): { token: string | null } | null {
  try {
    const raw = localStorage.getItem("auth");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Price helpers */
function dollarsFromCents(cents: number | undefined | null): string {
  const n = typeof cents === "number" ? cents : 0;
  return (n / 100).toFixed(2);
}
function centsFromDollars(input: string): number | null {
  const t = input.trim();
  if (t === "") return 0;
  const n = Number(t);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

export default function ProductEditPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const routeId = params?.id;
  const productId = Array.isArray(routeId) ? routeId[0] : routeId;

  const apiBase = useMemo(
    () => (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, ""),
    []
  );

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [replacingFile, setReplacingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editable fields
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState<string>("");
  const [priceInput, setPriceInput] = useState<string>(""); // dollars as string
  const [productType, setProductType] = useState<ProductType>("purchase");

  // File replacement (purchase only)
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!productId) {
      setError("Missing product id in route.");
      setLoading(false);
      return;
    }

    async function load() {
      setError(null);
      setLoading(true);
      try {
        const res = await fetch(`${apiBase}/api/products/${encodeURIComponent(productId)}`, {
          credentials: "include",
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Failed to load product (${res.status})`);
        }
        const data: unknown = await res.json();

        const titleV = getStringProp(data, "title") ?? "";
        const descV = getStringProp(data, "description") ?? "";
        const typeV = (getStringProp(data, "product_type") as ProductType) || "purchase";
        const priceV =
          getNumberProp(data, "price") ??
          ((): number => {
            const raw = getStringProp(data, "price");
            return raw ? Number(raw) || 0 : 0;
          })();

        if (!cancelled) {
          setTitle(titleV);
          setDescription(descV);
          setProductType(typeV);
          setPriceInput(dollarsFromCents(priceV));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load product");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [apiBase, productId]);

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    if (!productId) return;
    setError(null);

    const cents = centsFromDollars(priceInput);
    if (cents == null) {
      setError("Price must be a number (omit symbols).");
      return;
    }
    if (!title.trim()) {
      setError("Please enter a title.");
      return;
    }

    setSaving(true);
    try {
      const token = loadAuthSafe()?.token ?? null;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`${apiBase}/api/products/${encodeURIComponent(productId)}`, {
        method: "PUT",
        credentials: "include",
        headers,
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          price: cents,
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(extractMessage(payload, "Could not update product"));
      }

      router.push("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  async function replaceFile(e: React.FormEvent) {
    e.preventDefault();
    if (!productId) return;
    if (!file) {
      setError("Please choose a file to upload.");
      return;
    }
    setError(null);
    setReplacingFile(true);
    try {
      const token = loadAuthSafe()?.token ?? null;

      const formData = new FormData();
      formData.append("file", file);

      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`${apiBase}/api/products/${encodeURIComponent(productId)}/file`, {
        method: "PUT",
        credentials: "include",
        headers,
        body: formData,
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(extractMessage(payload, "Failed to update product file"));
      }

      router.push("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to replace file");
    } finally {
      setReplacingFile(false);
    }
  }

  const priceLabel =
    productType === "membership" ? "Price per month (USD)" : "Price (USD)";
  const pricePlaceholder =
    productType === "membership" ? "e.g., 12.00 per month" : "e.g., 12.00";

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold tracking-tight md:text-3xl">
        {loading ? "Loading…" : "Edit Product"}
      </h1>

      {error && (
        <div className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <form onSubmit={saveDetails} className="space-y-6 rounded-2xl border p-6" noValidate>
        {/* Product Type (read-only) */}
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="productType">
            Product Type
          </label>
          <input
            id="productType"
            value={productType}
            readOnly
            className="w-full rounded-xl border px-3 py-2 bg-neutral-50 text-neutral-700"
          />
          <p className="text-xs text-neutral-600">Product type cannot be changed once created.</p>
        </div>

        {/* Title */}
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="title">
            Title
          </label>
          <input
            id="title"
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-xl border px-3 py-2"
            required
          />
        </div>

        {/* Description */}
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="description">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            rows={5}
            value={description ?? ""}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-xl border px-3 py-2"
          />
        </div>

        {/* Price (dynamic label for membership) */}
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="price">
            {priceLabel}
          </label>
          <input
            id="price"
            name="price"
            inputMode="decimal"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            className="w-full rounded-xl border px-3 py-2"
            placeholder={pricePlaceholder}
          />
          <p className="text-xs text-neutral-600">
            Stored as integer cents{productType === "membership" ? " (monthly)." : "."}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className={`rounded-xl px-4 py-2 text-sm ${
              saving ? "bg-neutral-300 text-neutral-600" : "bg-black text-white"
            }`}
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="rounded-xl border px-4 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </form>

      {/* File replacement for purchase products */}
      {productType === "purchase" && (
        <form onSubmit={replaceFile} className="mt-6 space-y-4 rounded-2xl border p-6" noValidate>
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="file">
              Replace File (delivered to buyers)
            </label>
            <input
              id="file"
              name="file"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full rounded-xl border px-3 py-2"
            />
            <p className="text-xs text-neutral-600">
              PDF, images, video, text and other common formats supported.
            </p>
          </div>
          <button
            type="submit"
            disabled={replacingFile}
            className={`rounded-xl px-4 py-2 text-sm ${
              replacingFile ? "bg-neutral-300 text-neutral-600" : "bg-black text-white"
            }`}
          >
            {replacingFile ? "Updating…" : "Replace File"}
          </button>
        </form>
      )}
    </main>
  );
}