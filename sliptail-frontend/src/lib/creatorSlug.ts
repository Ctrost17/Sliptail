// src/lib/creatorSlug.ts

/**
 * Turn "Laura Covey" into "Laura-Covey".
 * We keep this intentionally simple:
 *  - trim
 *  - collapse whitespace to "-"
 *  - keep case/punctuation as-is (URL encoding handles it)
 */
export function toCreatorSlug(displayName: string | null | undefined): string {
  if (!displayName) return "";
  return displayName.trim().replace(/\s+/g, "-");
}

/**
 * Build the public profile path for a creator.
 * If we have a displayName, we use that; otherwise we fall back to the id.
 */
export function creatorProfilePath(
  displayName: string | null | undefined,
  fallbackId: number | string
): string {
  const slug = toCreatorSlug(displayName);
  const id = typeof fallbackId === "number" || typeof fallbackId === "string" ? String(fallbackId) : "";
  const key = slug || id; // prefer slug, fallback to id

  return `/creators/${encodeURIComponent(key)}`;
}
