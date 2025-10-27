"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { loadAuth } from "@/lib/auth";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

type ProductType = "purchase" | "membership" | "request";

type CreatorStatus = {
  profileComplete: boolean;
  stripeConnected: boolean;
  hasPublishedProduct?: boolean;
  isActive?: boolean;
};

function loadAuthSafe(): { token: string | null } | null {
  try {
    const raw = localStorage.getItem("auth");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Something went wrong";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function getProp(obj: unknown, key: string): unknown {
  if (!isRecord(obj)) return undefined;
  return obj[key];
}
function getStringProp(obj: unknown, key: string): string | undefined {
  const val = getProp(obj, key);
  return typeof val === "string" ? val : undefined;
}
function getArrayOfStrings(obj: unknown, key: string): string[] | undefined {
  const val = getProp(obj, key);
  return Array.isArray(val) && val.every((x) => typeof x === "string")
    ? (val as string[])
    : undefined;
}
function getIdAsString(obj: unknown): string | undefined {
  if (!isRecord(obj)) return undefined;
  const val = obj["id"];
  if (typeof val === "string" || typeof val === "number") return String(val);
  return undefined;
}
function getProductId(payload: unknown): string | undefined {
  const product = getProp(payload, "product");
  return getIdAsString(product);
}
function extractServerError(payload: unknown, fallback: string): string {
  const err =
    getStringProp(payload, "error") || getStringProp(payload, "message");
  if (err) return err;
  try {
    return isRecord(payload) ? JSON.stringify(payload) : fallback;
  } catch {
    return fallback;
  }
}

function parsePriceToCents(priceStr: string) {
  const t = priceStr.trim();
  if (t === "") return 0;
  const n = Number(t);
  if (Number.isNaN(n)) return NaN;
  return Math.round(n * 100);
}

type ApiResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  payload: unknown;
};
async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<ApiResponse> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, init);
  let payload: unknown = null;
  try {
    const ct = res.headers.get("content-type") || "";
    payload = ct.includes("application/json") ? await res.json() : await res.text();
  } catch {}
  return { ok: res.ok, status: res.status, statusText: res.statusText, payload };
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
    
    // Add authentication for local storage uploads
    const { token } = loadAuth();
    if (token && url.includes(API_BASE)) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }
    
    xhr.withCredentials = true; // Include cookies for CORS

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

export default function NewProductPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromSetup = (searchParams.get("from") || "").toLowerCase() === "setup";

  const [form, setForm] = useState<{
    productType: ProductType;
    title: string;
    description: string;
    price: string;
  }>({
    productType: "purchase",
    title: "",
    description: "",
    price: "",
  });

  const [file, setFile] = useState<File | null>(null);
  const [uploadPct, setUploadPct] = useState<number>(0);
  const [stage, setStage] = useState<"idle" | "presigning" | "uploading" | "finalizing">("idle");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<CreatorStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState<boolean>(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const IDS = {
    productType: "productType",
    productTypeHelp: "productTypeHelp",
    title: "title",
    description: "description",
    price: "price",
    priceHelp: "priceHelp",
    file: "productFile",
    fileHelp: "fileHelp",
    errorBox: "formError",
    readinessBox: "readinessBox",
  };

  useEffect(() => {
    if (form.productType !== "purchase") setFile(null);
  }, [form.productType]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatusLoading(true);
      setStatusError(null);
      try {
        const token = loadAuthSafe()?.token ?? null;
        const { ok, payload } = await apiFetch("/api/me/creator-status", {
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!ok) {
          if (!cancelled) setStatusError("Could not load creator status.");
          return;
        }
        if (isRecord(payload)) {
          const next: CreatorStatus = {
            profileComplete: Boolean(getProp(payload, "profileComplete")),
            stripeConnected: Boolean(getProp(payload, "stripeConnected")),
            hasPublishedProduct: Boolean(getProp(payload, "hasPublishedProduct")),
            isActive: Boolean(getProp(payload, "isActive")),
          };
          if (!cancelled) setStatus(next);
        }
      } catch (e) {
        if (!cancelled) setStatusError(getErrorMessage(e));
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function onChange<K extends keyof typeof form>(key: K) {
    return (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >
    ) => {
      const value = e.target.value;
      setForm((prev) => ({ ...prev, [key]: value }));
    };
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const title = form.title.trim();
    const description = form.description.trim();
    const productType = form.productType;
    const cents = parsePriceToCents(form.price);

    if (!title) {
      setError("Please enter a product title.");
      return;
    }
    if (form.price.trim() !== "" && Number.isNaN(cents)) {
      setError("Price must be a number (omit symbols).");
      return;
    }
    if (productType === "purchase" && !file) {
      setError("Please select a file to upload for this purchase product.");
      return;
    }

    setSaving(true);
    try {
      const token = loadAuthSafe()?.token ?? null;

      if (productType === "purchase" && file) {
  // 1) presign
  setStage("presigning");
  const presignRes = await apiFetch("/api/uploads/presign-product", {
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

  if (!presignRes.ok) {
    const msg = extractServerError(
      presignRes.payload,
      "Could not presign upload"
    );
    setError(`Presign failed — ${msg}`);
    setSaving(false);
    setStage("idle");
    return;
  }

  const { key, url, contentType } = (presignRes.payload ?? {}) as {
    key: string;
    url: string;
    contentType: string;
  };
  if (!key || !url) {
    setError("Presign response missing key or url");
    setSaving(false);
    setStage("idle");
    return;
  }

  // 2) direct upload to S3 with progress
  setStage("uploading");
  setUploadPct(0);
  try {
    await xhrPutWithProgress({
      url,
      file,
      contentType: contentType || file.type || "application/octet-stream",
      onProgress: (pct) => setUploadPct(pct),
    });
  } catch (e) {
    setError(getErrorMessage(e));
    setSaving(false);
    setStage("idle");
    return;
  }

  // 3) finalize: create the product pointing at the S3 key
  setStage("finalizing");
  const finalizeRes = await apiFetch("/api/products/upload-from-s3", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      key, // S3 key we just uploaded
      title,
      description,
      product_type: productType,
      productType,
      price: cents,
      price_cents: cents,
    }),
  });

  if (!finalizeRes.ok) {
    const base = extractServerError(finalizeRes.payload, "Failed to create product with file");
    if (finalizeRes.status === 403 && isRecord(finalizeRes.payload)) {
      const missing = getArrayOfStrings(finalizeRes.payload, "missing");
      const detail = getStringProp(finalizeRes.payload, "detail");
      const more =
        (missing && missing.length ? `\n• ${missing.join("\n• ")}` : "") +
        (detail ? `\n(${detail})` : "");
      setError(`Create failed (403 Forbidden) — ${base}${more ? `\n${more}` : ""}`);
    } else {
      setError(`Create failed (${finalizeRes.status}${finalizeRes.statusText ? " " + finalizeRes.statusText : ""}) — ${base}`);
    }
    setSaving(false);
    setStage("idle");
    return;
  }

  const productId = getProductId(finalizeRes.payload);
  if (fromSetup) {
    router.push(`/creator/success${productId ? `?pid=${encodeURIComponent(productId)}` : ""}`);
  } else {
    router.push("/dashboard");
  }
  return;
}


      const jsonPayload = {
        title,
        description,
        product_type: productType,
        productType,
        price: cents,
        price_cents: cents,
      };

      const { ok, status, statusText, payload } = await apiFetch(
        "/api/products/new",
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(jsonPayload),
        }
      );

      if (!ok) {
        if (status === 403 && isRecord(payload)) {
          const missing = getArrayOfStrings(payload, "missing");
          const detail = getStringProp(payload, "detail");
          const base = extractServerError(payload, "Failed to create product");
          const more =
            (missing && missing.length ? `\n• ${missing.join("\n• ")}` : "") +
            (detail ? `\n(${detail})` : "");
          setError(
            `Create failed (403 Forbidden) — ${base}${more ? `\n${more}` : ""}`
          );
        } else {
          const msg = extractServerError(payload, "Failed to create product");
          setError(
            `Create failed (${status}${statusText ? " " + statusText : ""}) — ${msg}`
          );
        }
        setSaving(false);
        return;
      }

      const productId = getProductId(payload);
      if (fromSetup) {
        router.push(
          `/creator/success${
            productId ? `?pid=${encodeURIComponent(productId)}` : ""
          }`
        );
      } else {
        router.push("/dashboard");
      }
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  const showReadinessBanner =
    !statusLoading &&
    (statusError ||
      (status && (!status.profileComplete || !status.stripeConnected)));

  // Dynamic price label + placeholder
  const priceLabel =
    form.productType === "membership" ? "Price per month (USD)" : "Price (USD)";
  const pricePlaceholder =
    form.productType === "membership" ? "e.g., 12.00 per month" : "e.g., 12.00";
  const priceHelpText =
    form.productType === "membership"
      ? "Leave blank for 0 (free). Stored as integer cents (monthly)."
      : "Leave blank for 0 (free). Stored as integer cents.";

  return (
    <div className="relative overflow-hidden min-h-screen bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400">
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold tracking-tight md:text-3xl">
        Create a New Product
      </h1>

      {showReadinessBanner && (
        <div
          id={IDS.readinessBox}
          role="status"
          className={`mb-6 rounded-2xl border p-4 text-sm ${
            statusError
              ? "border-yellow-300 bg-yellow-50 text-yellow-900"
              : "border-blue-300 bg-blue-50 text-blue-900"
          }`}
        >
          {statusError ? (
            <div>{statusError}</div>
          ) : (
            <>
              {!status?.profileComplete || !status?.stripeConnected ? (
                <div className="space-y-2">
                  <div className="font-medium">
                    Before you can publish or create products:
                  </div>
                  <ul className="list-disc pl-5">
                    {!status?.profileComplete && (
                      <li>Complete your creator profile</li>
                    )}
                    {!status?.stripeConnected && (
                      <li>Connect your Stripe account</li>
                    )}
                  </ul>
                  <div>
                    <a
                      href="/creator/setup"
                      className="inline-block rounded-xl bg-black px-3 py-1 text-white"
                    >
                      Go to Creator Setup
                    </a>
                  </div>
                </div>
              ) : (
                <div>Ready to create! 🚀</div>
              )}
            </>
          )}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="space-y-6 rounded-2xl bg-white shadow-sm ring-1 ring-black/5 p-6"
        noValidate
      >
        {/* Product Type */}
        <div className="space-y-2">
          <label
            htmlFor={IDS.productType}
            className="block text-sm font-medium"
          >
            Product Type
          </label>
          <select
            id={IDS.productType}
            name="productType"
            value={form.productType}
            onChange={onChange("productType")}
            aria-describedby={IDS.productTypeHelp}
            className="cursor-pointer w-full rounded-xl border px-3 py-2"
          >
            <option value="purchase">Purchase (downloadable)</option>
            <option value="membership">Membership</option>
            <option value="request">Request</option>
          </select>
          <p id={IDS.productTypeHelp} className="text-xs text-neutral-600">
            Choose how customers will buy or access this.
          </p>
        </div>

        {/* Title */}
        <div className="space-y-2">
          <label htmlFor={IDS.title} className="block text-sm font-medium">
            Title
          </label>
          <input
            id={IDS.title}
            name="title"
            value={form.title}
            onChange={onChange("title")}
            placeholder="e.g., Preset Pack Vol. 1"
            autoComplete="off"
            required
            className="w-full rounded-xl border px-3 py-2"
          />
        </div>

        {/* Description */}
        <div className="space-y-2">
          <label
            htmlFor={IDS.description}
            className="block text-sm font-medium"
          >
            Description
          </label>
          <textarea
            id={IDS.description}
            name="description"
            value={form.description}
            onChange={onChange("description")}
            rows={5}
            placeholder="Tell buyers what they'll get"
            className="w-full rounded-xl border px-3 py-2"
          />
        </div>

        {/* Price (dynamic label for membership) */}
        <div className="space-y-2">
          <label htmlFor={IDS.price} className="block text-sm font-medium">
            {priceLabel}
          </label>
          <input
            id={IDS.price}
            name="price"
            value={form.price}
            onChange={onChange("price")}
            inputMode="decimal"
            placeholder={pricePlaceholder}
            aria-describedby={IDS.priceHelp}
            autoComplete="off"
            className="w-full rounded-xl border px-3 py-2"
          />
        </div>
        <p id={IDS.priceHelp} className="text-xs text-neutral-600">
          {priceHelpText}
        </p>

        {/* File (purchase only) */}
        {form.productType === "purchase" && (
          <div className="space-y-2">
            <label htmlFor={IDS.file} className="block text-sm font-medium">
              Upload File (delivered to buyers)
            </label>

            <div className="flex items-center gap-3">
              <label
                htmlFor="file"
                className="inline-flex items-center rounded-lg bg-black text-white px-3 py-2 text-sm font-medium cursor-pointer"
              >
                Choose file
              </label>

              <input
                id="file"
                name="file"
                type="file"
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />

              <span className="text-sm text-neutral-800 truncate">
                {file?.name ?? "No file chosen"}
              </span>
            </div>

            <p id={IDS.fileHelp} className="text-xs text-neutral-600">
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
        )}  {/* ✅ close the purchase-only wrapper AND the conditional */}


        {error && (
          <div
            id={IDS.errorBox}
            role="alert"
            className="whitespace-pre-wrap rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          >
            {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className={`rounded-xl px-4 py-2 text-sm ${
              saving ? "bg-neutral-300 text-neutral-600" : "cursor-pointer bg-black text-white"
            }`}
          >
            {saving ? "Creating…" : "Create Product"}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="cursor-pointer rounded-xl border px-4 py-2 text-sm"
          >
            Cancel
          </button>
        </div>
      </form>
    </main>
    </div>
  );
}
