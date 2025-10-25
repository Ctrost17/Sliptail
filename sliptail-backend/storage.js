// storage.js — dual driver (local | s3)
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const DRIVER = String(process.env.STORAGE_DRIVER || "local").toLowerCase();
const isS3 = DRIVER === "s3";

// CloudFront signer (rename to avoid clash with S3 presigner)
const { getSignedUrl: getCFSignedUrl } = require("@aws-sdk/cloudfront-signer");
// CF env
const CF_DOMAIN = process.env.CF_PRIVATE_DOMAIN || null; // e.g. "https://dxxx.cloudfront.net"
const CF_KEY_PAIR_ID = process.env.CF_KEY_PAIR_ID || null;
const CF_PRIVKEY_B64 = process.env.CF_PRIVATE_KEY_PEM_BASE64 || null;
const CF_PRIVKEY = CF_PRIVKEY_B64 ? Buffer.from(CF_PRIVKEY_B64, "base64").toString("utf8") : null;

/* -------------------- LOCAL DRIVER -------------------- */
async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

// Map keys to local filesystem
function normalizeLocalKey(key) {
  // Accept "/uploads/...", "uploads/...", or bare "requests/..."/"products/.../creators/..."
  let k = String(key || "").trim();
  if (!k) return null;
  k = k.replace(/^\/+/, ""); // strip leading "/"
  if (k.startsWith("uploads/")) return k;
  if (
    k.startsWith("requests/") ||
    k.startsWith("products/") ||
    k.startsWith("creators/")
  ) {
    return `uploads/${k}`;
  }
  return `uploads/${k}`; // fallback
}

const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
// IMPORTANT: one root for local reads+writes
const LOCAL_UPLOADS_ROOT =
  process.env.LOCAL_UPLOADS_DIR || path.join(PUBLIC_DIR, "uploads");

/* -------------------- S3 DRIVER -------------------- */
let s3 = null;
let GetObjectCommand = null;
let PutObjectCommand = null;
let DeleteObjectCommand = null;
let ListObjectsV2Command = null; // ← ADD
let s3Presign = null;
let Upload = null;

let PRIVATE_BUCKET = null;
let PUBLIC_BUCKET = null;
let S3_REGION = null;

const S3_PUBLIC_BASE_URL = process.env.S3_PUBLIC_BASE_URL || null; // e.g. https://cdn.example.com
const ALLOW_PUBLIC_ACL =
  String(process.env.S3_ALLOW_PUBLIC_ACL || "false").toLowerCase() === "true";

// Optional server-side encryption settings
const S3_SSE = process.env.S3_SSE || null; // e.g. "AES256" or "aws:kms"
const S3_SSE_KMS_KEY_ID = process.env.S3_SSE_KMS_KEY_ID || null; // if using KMS

if (DRIVER === "s3") {
  const { S3Client } = require("@aws-sdk/client-s3");
  ({ GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command} =
    require("@aws-sdk/client-s3"));
  ({ getSignedUrl: s3Presign } = require("@aws-sdk/s3-request-presigner"));
  // Multipart uploader (great for streams/large files)
  try {
    ({ Upload } = require("@aws-sdk/lib-storage"));
  } catch {
    Upload = null; // optional dependency
  }

  S3_REGION = process.env.S3_REGION || "us-east-2";
  PRIVATE_BUCKET = process.env.S3_PRIVATE_BUCKET;
  PUBLIC_BUCKET = process.env.S3_PUBLIC_BUCKET || null; // optional

  if (!PRIVATE_BUCKET)
    throw new Error("S3_PRIVATE_BUCKET is required when STORAGE_DRIVER=s3");

  // If ACCESS_KEY/SECRET are omitted and the instance has a role, the SDK will use it.
  s3 = new S3Client({
    region: S3_REGION,
    credentials:
      process.env.S3_PRIVATE_ACCESS_KEY_ID &&
      process.env.S3_PRIVATE_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_PRIVATE_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_PRIVATE_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
}

/* -------------------- helpers -------------------- */
function joinUrl(base, key) {
  // encode each segment but keep slashes
  const safeKey = String(key)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${String(base).replace(/\/+$/, "")}/${safeKey}`;
}

// Decide whether to use multipart uploader
function shouldUseMultipart(body) {
  // Use multipart when we have a stream or a file path (string),
  // or when Upload is available and body is NOT a Buffer.
  if (!Upload) return false;
  if (typeof body === "string") return true; // treat as file path
  if (body && typeof body.pipe === "function") return true; // Node readable
  return !(body instanceof Buffer);
}

// Convert "body" which may be Buffer | string(file path) | Readable into a suitable stream
function toBodyStream(body) {
  if (typeof body === "string") {
    // file path
    return fs.createReadStream(body);
  }
  return body;
}

// Common S3 put params with optional SSE
function withSse(params) {
  if (S3_SSE) {
    params.ServerSideEncryption = S3_SSE;
    if (S3_SSE === "aws:kms" && S3_SSE_KMS_KEY_ID) {
      params.SSEKMSKeyId = S3_SSE_KMS_KEY_ID;
    }
  }
  return params;
}

function isPostKey(raw) {
  const k = String(raw || "").replace(/^\/+/, "");
  // You store post media keys like "posts/<id>.<ext>" in DB.
  // Treat anything under "posts/" as feed content (including posters saved next to it).
  return k.startsWith("posts/");
}

/* ==================== PUBLIC API ==================== */

/**
 * uploadPrivate({ key, contentType, body })
 * LOCAL: writes to <LOCAL_UPLOADS_ROOT>/<key>; returns { key: "/uploads/<key>", url: "/uploads/<key>" }
 * S3:   PutObject/Multipart to PRIVATE_BUCKET; returns { key } (no public URL – use getPrivateUrl for presign)
 *
 * Accepts: body as Buffer | string (file path) | Readable stream
 */
async function uploadPrivate({ key, contentType, body }) {
  if (!key) throw new Error("uploadPrivate: key is required");

  if (DRIVER === "s3") {
    const ContentType = contentType || "application/octet-stream";

    if (shouldUseMultipart(body)) {
      // Multipart upload (streams or large files)
      const uploader = new Upload({
        client: s3,
        params: withSse({
          Bucket: PRIVATE_BUCKET,
          Key: key,
          Body: toBodyStream(body),
          ContentType,
        }),
        queueSize: 4, // parallel parts
        partSize: 8 * 1024 * 1024, // 8MB
        leavePartsOnError: false,
      });
      await uploader.done();
    } else {
      // Single PUT (buffers/small files)
      const put = new PutObjectCommand(
        withSse({
          Bucket: PRIVATE_BUCKET,
          Key: key,
           Body: toBodyStream(body),
          ContentType,
        })
      );
      await s3.send(put);
    }
    return { key };
  }

  // LOCAL
  const rel = String(key).replace(/^\/+/, "").replace(/^uploads\//, "");
  const absDir = path.join(LOCAL_UPLOADS_ROOT, path.dirname(rel));
  const absPath = path.join(LOCAL_UPLOADS_ROOT, rel);
  await ensureDir(absDir);

  if (typeof body === "string") {
    // file path -> copy
    await fsp.copyFile(body, absPath);
  } else {
    await fsp.writeFile(absPath, body);
  }

  const webPath = `/uploads/${rel}`;
  return { key: webPath, url: webPath };
}

/**
 * uploadPublic({ key, contentType, body, expiresIn })
 * LOCAL: same as private; returns direct web path.
 * S3:
 *   - If S3_PUBLIC_BUCKET is set: upload there and return URL using S3_PUBLIC_BASE_URL if provided,
 *     otherwise return the raw "https://<bucket>.s3.<region>.amazonaws.com/<key>".
 *   - Else if ALLOW_PUBLIC_ACL=true: upload to PRIVATE_BUCKET with ACL: public-read and return URL.
 *   - Else: upload to PRIVATE_BUCKET and return a *presigned* URL (expiresIn default 1 day).
 *
 * Accepts: body as Buffer | string (file path) | Readable stream
 */
async function uploadPublic({
  key,
  contentType,
  body,
  expiresIn = 24 * 60 * 60,
}) {
  if (!key) throw new Error("uploadPublic: key is required");

  if (DRIVER === "s3") {
    const bucket = PUBLIC_BUCKET || PRIVATE_BUCKET;
    const ContentType = contentType || "application/octet-stream";

    if (shouldUseMultipart(body)) {
      const uploader = new Upload({
        client: s3,
        params: withSse({
          Bucket: bucket,
          Key: key,
          Body: toBodyStream(body),
          ContentType,
          ...(PUBLIC_BUCKET ? {} : ALLOW_PUBLIC_ACL ? { ACL: "public-read" } : {}),
        }),
        queueSize: 4,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
      });
      await uploader.done();
    } else {
      const params = withSse({
        Bucket: bucket,
        Key: key,
         Body: toBodyStream(body),
        ContentType,
        ...(PUBLIC_BUCKET ? {} : ALLOW_PUBLIC_ACL ? { ACL: "public-read" } : {}),
      });
      await s3.send(new PutObjectCommand(params));
    }

    // Build a URL
    if (PUBLIC_BUCKET && S3_PUBLIC_BASE_URL) {
      return { key, url: joinUrl(S3_PUBLIC_BASE_URL, key) };
    }
    if (PUBLIC_BUCKET && !S3_PUBLIC_BASE_URL) {
      // Default S3 URL
      return {
        key,
        url: `https://${PUBLIC_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`,
      };
    }
    if (!PUBLIC_BUCKET && ALLOW_PUBLIC_ACL) {
      return {
        key,
        url: `https://${PRIVATE_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`,
      };
    }

    // Fallback: no public bucket and public ACL blocked -> presigned URL
    const cmd = new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key });
    const url = await s3Presign(s3, cmd, { expiresIn });
    return { key, url };
  }

  // LOCAL
  const rel = String(key).replace(/^\/+/, "").replace(/^uploads\//, "");
  const absDir = path.join(LOCAL_UPLOADS_ROOT, path.dirname(rel));
  const absPath = path.join(LOCAL_UPLOADS_ROOT, rel);
  await ensureDir(absDir);

  if (typeof body === "string") {
    await fsp.copyFile(body, absPath);
  } else {
    await fsp.writeFile(absPath, body);
  }

  const webPath = `/uploads/${rel}`;
  return { key: webPath, url: webPath };
}

function isCdnEligibleKey(raw) {
  const k = String(raw || "").replace(/^\/+/, "");
  return (
    k.startsWith("posts/") ||
    k.startsWith("products/") ||
    k.startsWith("requests/")
  );
}

/**
 * getPrivateUrl(key, { expiresIn })
 * LOCAL: returns "/uploads/..." path.
 * S3:    For posts/* -> sign CloudFront URL if CF_* env is set; otherwise S3 presign.
 *        For everything else -> S3 presign.
 */
async function getPrivateUrl(key, { expiresIn = 900 } = {}) {
  if (DRIVER === "s3") {
    const k = String(key).replace(/^\/+/, "");

    // CloudFront for posts/products/requests when CF is configured
    if (CF_DOMAIN && CF_KEY_PAIR_ID && CF_PRIVKEY && isCdnEligibleKey(k)) {
      const url = `${CF_DOMAIN.replace(/\/+$/, "")}/${k
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;

      return getCFSignedUrl({
        url,
        keyPairId: CF_KEY_PAIR_ID,
        privateKey: CF_PRIVKEY,
        dateLessThan: new Date(Date.now() + expiresIn * 1000).toISOString(),
      });
    }

    // Fallback: S3 presigned GET
    const cmd = new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: k });
    return await s3Presign(s3, cmd, { expiresIn });
  }

  // LOCAL
  const k = normalizeLocalKey(key);
  return `/${k}`;
}

/**
 * getPublicUrl(key)
 * LOCAL: returns "/uploads/..." path.
 * S3:    if PUBLIC bucket or public ACL is allowed, return direct URL; else presign.
 */
async function getPublicUrl(key, { expiresIn = 24 * 60 * 60 } = {}) {
  if (DRIVER === "s3") {
    const k = String(key).replace(/^\/+/, "");
    if (PUBLIC_BUCKET && S3_PUBLIC_BASE_URL) {
      return joinUrl(S3_PUBLIC_BASE_URL, k);
    }
    if (PUBLIC_BUCKET) {
      return `https://${PUBLIC_BUCKET}.s3.${S3_REGION}.amazonaws.com/${k}`;
    }
    if (ALLOW_PUBLIC_ACL) {
      return `https://${PRIVATE_BUCKET}.s3.${S3_REGION}.amazonaws.com/${k}`;
    }
    // presign fallback
    const cmd = new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: k });
    return await s3Presign(s3, cmd, { expiresIn });
  }
  const k = normalizeLocalKey(key);
  return `/${k}`;
}

/**
 * getReadStreamAndMeta(key, rangeHeader)
 * Returns: { stream, contentType, contentLength, contentRange, acceptRanges }
 */
async function getReadStreamAndMeta(key, rangeHeader) {
  if (DRIVER === "s3") {
    const k = String(key).replace(/^\/+/, "");
    const params = {
      Bucket: PRIVATE_BUCKET,
      Key: k,
      ...(rangeHeader ? { Range: rangeHeader } : {}),
    };
    const data = await s3.send(new GetObjectCommand(params));
    return {
      stream: data.Body,
      contentType: data.ContentType || "application/octet-stream",
      contentLength: data.ContentLength,
      contentRange: data.ContentRange,
      acceptRanges: data.AcceptRanges,
    };
  }

  // LOCAL
  const rel = normalizeLocalKey(key); // "uploads/..."
  // IMPORTANT: read from the same root where we write
  const abs = path.join(LOCAL_UPLOADS_ROOT, rel.replace(/^uploads\//, ""));
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch (err) {
    err.code = err.code || "ENOENT";
    throw err;
  }

  let start = 0;
  let end = stat.size - 1;
  let contentRange;
  let streamOpts = {};

  if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
    const [s, e] = rangeHeader.replace("bytes=", "").split("-");
    if (s !== "") start = parseInt(s, 10);
    if (e !== "") end = parseInt(e, 10);
    if (start <= end && start < stat.size) {
      contentRange = `bytes ${start}-${end}/${stat.size}`;
      streamOpts = { start, end };
    } else {
      start = 0;
      end = stat.size - 1;
    }
  }

  const stream = fs.createReadStream(abs, streamOpts);

  // naive content type; add mime lookup if needed
  const contentType = "application/octet-stream";
  const contentLength = end - start + 1;
  const acceptRanges = "bytes";

  return { stream, contentType, contentLength, contentRange, acceptRanges };
}

/**
 * deletePrivate(key) — best-effort delete by key from the private store
 */
async function deletePrivate(key) {
  if (!key) return;
  if (DRIVER === "s3") {
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: PRIVATE_BUCKET,
          Key: String(key).replace(/^\/+/, ""),
        })
      );
    } catch (e) {
      console.warn("S3 deletePrivate failed:", e?.message || e);
    }
    return;
  }
  // LOCAL
  try {
    const rel = normalizeLocalKey(key).replace(/^uploads\//, "");
    const abs = path.join(LOCAL_UPLOADS_ROOT, rel);
    await fsp.unlink(abs);
  } catch (_) {
    // ignore
  }
}

/**
 * listPublicPrefix(prefix) → Array<string> keys
 * S3: lists objects under PUBLIC_BUCKET (or PRIVATE if no public bucket).
 * LOCAL: lists files under uploads/ when the prefix matches; returns paths relative to /uploads.
 */
async function listPublicPrefix(prefix) {
  const pfx = String(prefix || "").replace(/^\/+/, "");
  if (!pfx) return [];

  if (DRIVER === "s3") {
    const bucket = PUBLIC_BUCKET  || PRIVATE_BUCKET;
    const keys = [];
    let ContinuationToken = undefined;

    do {
      const resp = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: pfx,
          ContinuationToken,
        })
      );
      for (const obj of resp.Contents || []) {
        if (obj && obj.Key) keys.push(String(obj.Key));
      }
      ContinuationToken = resp.NextContinuationToken;
    } while (ContinuationToken);

    return keys;
  }

  // LOCAL: list from the same root we write to
  const localPrefix = pfx.startsWith("uploads/") ? pfx.replace(/^uploads\//, "") : pfx;
  const baseDir = LOCAL_UPLOADS_ROOT;
  const out = [];

  async function walk(dir, rel) {
    const full = path.join(dir, rel);
    let entries = [];
    try { entries = await fsp.readdir(full, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const nextRel = path.join(rel, e.name);
      if (e.isDirectory()) await walk(dir, nextRel);
      else out.push(`uploads/${nextRel.replace(/\\/g, "/")}`);
    }
  }

  // If prefix is a directory, walk it; else try to stat the file.
  const startDir = path.join(baseDir, localPrefix);
  try {
    const st = await fsp.stat(startDir);
    if (st.isDirectory()) {
      await walk(baseDir, localPrefix);
      return out;
    }
    // single file
    return [`uploads/${localPrefix}`];
  } catch {
    return [];
  }
}

/**
 * deletePublic(key)
 * S3: deletes from PUBLIC_BUCKET if set, else PRIVATE_BUCKET.
 * LOCAL: deletes from uploads/.
 */
async function deletePublic(key) {
  const k = String(key || "").replace(/^\/+/, "");
  if (!k) return;

  if (DRIVER === "s3") {
    const bucket = PUBLIC_BUCKET || PRIVATE_BUCKET;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k }));
    } catch (e) {
      console.warn("S3 deletePublic failed:", e?.message || e);
    }
    return;
  }

  // LOCAL
  try {
    const rel = k.replace(/^uploads\//, "");
    const abs = path.join(LOCAL_UPLOADS_ROOT, rel);
    await fsp.unlink(abs);
  } catch {
    /* ignore */
  }
}

/**
 * keyFromPublicUrl(url) → "<key>"
 * Extract the S3 key (or local "/uploads/..." path) from a full URL or path.
 */
function keyFromPublicUrl(url) {
  if (!url) return "";
  const u = String(url);

  // If it's already a "/uploads/..." web path, strip leading slash and return
  if (/^\/?uploads\//.test(u)) return u.replace(/^\/+/, "");

  // S3 public bucket base
  if (S3_PUBLIC_BASE_URL && u.startsWith(S3_PUBLIC_BASE_URL)) {
    return u.slice(S3_PUBLIC_BASE_URL.length).replace(/^\/+/, "");
  }
  // Raw S3 bucket URL (public or private)
  const s3Host = PUBLIC_BUCKET
    ? `https://${PUBLIC_BUCKET}.s3.${S3_REGION}.amazonaws.com/`
    : `https://${PRIVATE_BUCKET}.s3.${S3_REGION}.amazonaws.com/`;
  if (u.startsWith(s3Host)) {
    return u.slice(s3Host.length);
  }

  // Fallback: treat it as a path and remove the leading slash
  try {
    const parsed = new URL(u);
    return parsed.pathname.replace(/^\/+/, "");
  } catch {
    return u.replace(/^\/+/, "");
  }
}

// --- ADD at bottom with module.exports:
async function getPresignedPutUrl(key, { contentType = "application/octet-stream", expiresIn = 3600 } = {}) {
  if (DRIVER !== "s3") throw new Error("Presigned PUT only available for S3");
  const cmd = new PutObjectCommand({
    Bucket: PRIVATE_BUCKET,
    Key: String(key).replace(/^\/+/, ""),
    ContentType: contentType,
  });
  return await s3Presign(s3, cmd, { expiresIn });
}

/**
 * getSignedDownloadUrl(key, { filename, expiresSeconds })
 * - If CF_* set: returns CloudFront signed URL for *any* key (not just posts),
 *   with query params to force native "Save as" download.
 * - Else: S3 pre-signed GET with Response* overrides.
 */
async function getSignedDownloadUrl(
  key,
  { filename = null, expiresSeconds = 60 } = {}
) {
  const k = String(key).replace(/^\/+/, "");
  const safeName = (filename || k.split("/").pop() || "download").replace(/"/g, "");

  // Prefer CloudFront if configured — REQUIRES query-string forwarding on the CF behavior
  if (CF_DOMAIN && CF_KEY_PAIR_ID && CF_PRIVKEY) {
    const u = new URL(
      `${CF_DOMAIN.replace(/\/+$/, "")}/${k
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`
    );

    // Forward these so S3 sets the headers on response
    u.searchParams.set(
      "response-content-disposition",
      `attachment; filename="${encodeURIComponent(safeName)}"`
    );
    u.searchParams.set("response-content-type", "application/octet-stream");

    return getCFSignedUrl({
      url: u.toString(),
      keyPairId: CF_KEY_PAIR_ID,
      privateKey: CF_PRIVKEY,
      dateLessThan: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
    });
  }

  // Fallback: S3 pre-signed GET with response overrides
  const cmd = new GetObjectCommand({
    Bucket: PRIVATE_BUCKET,
    Key: k,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
    ResponseContentType: "application/octet-stream",
  });
  return await s3Presign(s3, cmd, { expiresIn: expiresSeconds });
}

module.exports = {
  DRIVER,
  isS3,
  uploadPrivate,
  uploadPublic,
  getPrivateUrl,
  getPublicUrl,
  getReadStreamAndMeta,
  deletePrivate, // new
  // normalizeLocalKey is not exported publicly, but add it if you want
  listPublicPrefix,
  deletePublic,
  keyFromPublicUrl,
  getPresignedPutUrl,
  getSignedDownloadUrl,
};
