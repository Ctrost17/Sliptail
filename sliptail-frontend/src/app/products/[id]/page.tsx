"use client";

import { useEffect, useState } from "react";
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

  const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [replacingFile, setReplacingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number>(0);
  const [stage, setStage] = useState<"idle" | "presigning" | "uploading" | "finalizing">("idle");

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
        const res = await fetch(`${API_BASE}/api/products/${encodeURIComponent(productId)}`, {
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
  }, [API_BASE, productId]);

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

      const res = await fetch(`${API_BASE}/api/products/${encodeURIComponent(productId)}`, {
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

  async function xhrPutWithProgress(opts: {
    url: string;
    file: File | Blob;
    contentType: string;
    onProgress?: (pct: number) => void;
    }): Promise<void> {
      const { url, file, contentType, onProgress } = opts;
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", url);
        xhr.setRequestHeader("Content-Type", contentType);

        xhr.upload.onprogress = (evt) => {
          if (!evt.lengthComputable) return;
          const pct = Math.max(0, Math.min(100, (evt.loaded / evt.total) * 100));
          onProgress?.(pct);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`S3 upload failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error("Network error during S3 upload"));
        xhr.send(file);
      });
    }

    async function xhrFormPutWithProgress(opts: {
        url: string;
        formData: FormData;
        authToken?: string;
        onProgress?: (pct: number) => void;
      }): Promise<Response> {
        return await new Promise<Response>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", opts.url);
          // match your fetch credentials behavior
          xhr.withCredentials = true;
          if (opts.authToken) {
            xhr.setRequestHeader("Authorization", `Bearer ${opts.authToken}`);
          }
          xhr.upload.onprogress = (evt) => {
            if (!evt.lengthComputable) return;
            const pct = Math.max(0, Math.min(100, (evt.loaded / evt.total) * 100));
            opts.onProgress?.(pct);
          };
          xhr.onload = () => {
            // build a Response-like object so the caller can .ok/.status if needed
            const res = new Response(xhr.response, { status: xhr.status, statusText: xhr.statusText });
            if (xhr.status >= 200 && xhr.status < 300) resolve(res);
            else reject(new Error(`Upload failed (${xhr.status})`));
          };
          xhr.onerror = () => reject(new Error("Network error during upload"));
          xhr.send(opts.formData);
        });
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
      setStage("presigning");
      setUploadPct(0);

      const token = loadAuthSafe()?.token ?? null;

      // small helper: direct upload fallback to the multer route with progress
      const fallbackDirectUpload = async () => {
        setStage("uploading");
        const formData = new FormData();
        formData.append("file", file);

        try {
          await xhrFormPutWithProgress({
            url: `${API_BASE}/api/products/${encodeURIComponent(productId)}/file`,
            formData,
            authToken: token || undefined,
            onProgress: (pct) => setUploadPct(pct),
          });
          router.push("/dashboard");
        } catch (err) {
          throw err; // bubble up to the outer catch
        }
      };

      try {
        // 1) presign
        const presignRes = await fetch(`${API_BASE}/api/uploads/presign-product`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type || "application/octet-stream",
          }),
        });

        // If requireCreator blocks (401/403), fall back to direct upload
        if (!presignRes.ok) {
          if (presignRes.status === 401 || presignRes.status === 403) {
            // fallback path
            return await fallbackDirectUpload();
          }
          // other presign errors -> surface message
          const payload = await presignRes.json().catch(() => ({}));
          throw new Error(extractMessage(payload, "Could not presign upload"));
        }

        const { key, url, contentType } = (await presignRes.json()) as {
          key: string;
          url: string;
          contentType: string;
        };
        if (!key || !url) throw new Error("Presign response missing key or url");

        // 2) upload to S3 with progress
        setStage("uploading");
        await xhrPutWithProgress({
          url,
          file,
          contentType: contentType || file.type || "application/octet-stream",
          onProgress: (pct) => setUploadPct(pct),
        });

        // 3) finalize on server
        setStage("finalizing");
        const finalizeRes = await fetch(
          `${API_BASE}/api/products/${encodeURIComponent(productId)}/file-from-s3`,
          {
            method: "PUT",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ key }),
          }
        );

        if (!finalizeRes.ok) {
          // If finalize rejects with 403 (ownership, etc.), there’s no point falling back now,
          // because the file is already in S3 but DB update failed. Show message.
          const payload = await finalizeRes.json().catch(() => ({}));
          throw new Error(extractMessage(payload, "Failed to update product file"));
        }

        router.push("/dashboard");
      } catch (e) {
        // If S3 PUT itself failed for a network reason, the file hasn't been attached yet.
        // Try a last-chance fallback to direct upload.
        const msg = e instanceof Error ? e.message : String(e);
        if (stage === "uploading") {
          try {
            await fallbackDirectUpload();
            return; // success via fallback
          } catch (fallbackErr) {
            setError(fallbackErr instanceof Error ? fallbackErr.message : "Failed to replace file");
          }
        } else {
          setError(msg || "Failed to replace file");
        }
      } finally {
        setReplacingFile(false);
        setStage("idle");
      }
    }

  const priceLabel =
    productType === "membership" ? "Price per month (USD)" : "Price (USD)";
  const pricePlaceholder =
    productType === "membership" ? "e.g., 12.00 per month" : "e.g., 12.00";

  return (
     <div className="relative overflow-hidden min-h-screen bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400">
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold tracking-tight md:text-3xl">
        {loading ? "Loading…" : "Edit Product"}
      </h1>

      {error && (
        <div className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <form onSubmit={saveDetails} className="space-y-6 rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-6" noValidate>
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
              saving ? "bg-neutral-300 text-neutral-600" : "cursor-pointer bg-black text-white"
            }`}
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="cursor-pointer rounded-xl border px-4 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </form>

      {/* File replacement for purchase products */}
      {productType === "purchase" && (
        <form onSubmit={replaceFile} className="space-y-6 rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-6" noValidate>
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="file">
              Replace File (delivered to buyers)
            </label>
              <div className="flex items-center gap-3">
                {/* Styled button that triggers the hidden file input */}
                <label
                  htmlFor="file"
                  className="inline-flex items-center rounded-lg bg-black text-white px-3 py-2 text-sm font-medium cursor-pointer"
                >
                  Choose file
                </label>

                {/* Visually hidden input; still accessible via the label above */}
                <input
                  id="file"
                  name="file"
                  type="file"
                  className="sr-only"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />

                {/* File name stays visible */}
                <span className="text-sm text-neutral-800 truncate">
                  {file?.name ?? "No file chosen"}
                </span>
              </div>
            <p className="text-xs text-neutral-600">
              PDF, images, video, text and other common formats supported.
            </p>
            {stage !== "idle" && (
            <div className="mt-2 space-y-1">
              <div className="text-xs text-neutral-700">
                {stage === "presigning" && "Preparing upload…"}
                {stage === "uploading" && `Uploading… ${uploadPct.toFixed(0)}%`}
                {stage === "finalizing" && "Finalizing…"}
              </div>
              {(stage === "uploading" || stage === "finalizing") && (
                <div className="h-2 w-full rounded-full bg-neutral-200 overflow-hidden">
                  <div
                    className="h-2 bg-black transition-all"
                    style={{ width: `${stage === "finalizing" ? 100 : Math.min(100, uploadPct)}%` }}
                  />
                </div>
              )}
            </div>
          )}
          </div>
        <button
          type="submit"
          disabled={replacingFile || stage !== "idle"}
          className={`rounded-xl px-4 py-2 text-sm ${
            replacingFile || stage !== "idle"
              ? "bg-neutral-300 text-neutral-600"
              : "cursor-pointer bg-black text-white"
          }`}
        >
          {stage === "presigning" && "Preparing…"}
          {stage === "uploading" && `Uploading… ${uploadPct.toFixed(0)}%`}
          {stage === "finalizing" && "Finalizing…"}
          {stage === "idle" && (replacingFile ? "Updating…" : "Replace File")}
        </button>
        </form>
      )}
    </main>
    </div>
  );
}