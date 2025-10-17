// storage.js — dual driver (local | s3)
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const DRIVER = String(process.env.STORAGE_DRIVER || "local").toLowerCase();
const isS3 = DRIVER === "s3";

/* -------------------- LOCAL DRIVER -------------------- */
async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

// Map keys to local filesystem
function normalizeLocalKey(key) {
  // Accept "/uploads/...", "uploads/...", or bare "requests/..."/"products/..."
  let k = String(key || "").trim();
  if (!k) return null;
  k = k.replace(/^\/+/, ""); // strip leading "/"
  if (k.startsWith("uploads/")) return k;
  if (k.startsWith("requests/") || k.startsWith("products/") || k.startsWith("creators/")) {
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
let getSignedUrl = null;
let PRIVATE_BUCKET = null;
let PUBLIC_BUCKET = null;
let S3_REGION = null;
const S3_PUBLIC_BASE_URL = process.env.S3_PUBLIC_BASE_URL || null; // e.g. https://cdn.example.com
const ALLOW_PUBLIC_ACL = String(process.env.S3_ALLOW_PUBLIC_ACL || "false").toLowerCase() === "true";

if (DRIVER === "s3") {
  const { S3Client } = require("@aws-sdk/client-s3");
  ({ GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3"));
  ({ getSignedUrl } = require("@aws-sdk/s3-request-presigner"));

  S3_REGION = process.env.S3_REGION || "us-east-2";
  PRIVATE_BUCKET = process.env.S3_PRIVATE_BUCKET;
  PUBLIC_BUCKET  = process.env.S3_PUBLIC_BUCKET || null; // optional

  if (!PRIVATE_BUCKET) throw new Error("S3_PRIVATE_BUCKET is required when STORAGE_DRIVER=s3");

  s3 = new S3Client({
    region: S3_REGION,
    credentials:
      process.env.S3_PRIVATE_ACCESS_KEY_ID && process.env.S3_PRIVATE_SECRET_ACCESS_KEY
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
  const safeKey = key.split("/").map(encodeURIComponent).join("/");
  return `${base.replace(/\/+$/, "")}/${safeKey}`;
}

/* ==================== PUBLIC API ==================== */

/**
 * uploadPrivate({ key, contentType, body })
 * LOCAL: writes to <LOCAL_UPLOADS_ROOT>/<key>; returns { key: "/uploads/<key>", url: "/uploads/<key>" }
 * S3:   PutObject to PRIVATE_BUCKET; returns { key } (no public URL – use getPrivateUrl for presign)
 */
async function uploadPrivate({ key, contentType, body }) {
  if (!key) throw new Error("uploadPrivate: key is required");

  if (DRIVER === "s3") {
    const put = new PutObjectCommand({
      Bucket: PRIVATE_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    });
    await s3.send(put);
    return { key };
  }

  // LOCAL
  const rel = key.replace(/^\/+/, "").replace(/^uploads\//, "");
  const absDir = path.join(LOCAL_UPLOADS_ROOT, path.dirname(rel));
  const absPath = path.join(LOCAL_UPLOADS_ROOT, rel);
  await ensureDir(absDir);
  await fsp.writeFile(absPath, body);
  const webPath = `/uploads/${rel}`;
  return { key: webPath, url: webPath };
}

/**
 * uploadPublic({ key, contentType, body })
 * LOCAL: same as private; returns direct web path.
 * S3:
 *   - If S3_PUBLIC_BUCKET is set: upload there and return URL using S3_PUBLIC_BASE_URL if provided,
 *     otherwise return the raw "https://<bucket>.s3.<region>.amazonaws.com/<key>".
 *   - Else if ALLOW_PUBLIC_ACL=true: upload to PRIVATE_BUCKET with ACL: public-read and return URL.
 *   - Else: upload to PRIVATE_BUCKET and return a *presigned* URL (expiresIn default 1 day).
 */
async function uploadPublic({ key, contentType, body, expiresIn = 24 * 60 * 60 }) {
  if (!key) throw new Error("uploadPublic: key is required");

  if (DRIVER === "s3") {
    const bucket = PUBLIC_BUCKET || PRIVATE_BUCKET;
    const params = {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
      ...(PUBLIC_BUCKET ? {} : (ALLOW_PUBLIC_ACL ? { ACL: "public-read" } : {})),
    };

    await s3.send(new PutObjectCommand(params));

    // Build a URL
    if (PUBLIC_BUCKET && S3_PUBLIC_BASE_URL) {
      return { key, url: joinUrl(S3_PUBLIC_BASE_URL, key) };
    }
    if (PUBLIC_BUCKET && !S3_PUBLIC_BASE_URL) {
      // Default S3 URL
      return { key, url: `https://${PUBLIC_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}` };
    }
    if (!PUBLIC_BUCKET && ALLOW_PUBLIC_ACL) {
      return { key, url: `https://${PRIVATE_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}` };
    }

    // Fallback: no public bucket and public ACL blocked -> give presigned URL
    const cmd = new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key });
    const url = await getSignedUrl(s3, cmd, { expiresIn });
    return { key, url };
  }

  // LOCAL
  const rel = key.replace(/^\/+/, "").replace(/^uploads\//, "");
  const absDir = path.join(LOCAL_UPLOADS_ROOT, path.dirname(rel));
  const absPath = path.join(LOCAL_UPLOADS_ROOT, rel);
  await ensureDir(absDir);
  await fsp.writeFile(absPath, body);
  const webPath = `/uploads/${rel}`;
  return { key: webPath, url: webPath };
}

/**
 * getPrivateUrl(key, { expiresIn })
 * LOCAL: returns "/uploads/..." path.
 * S3:    returns presigned GET URL.
 */
async function getPrivateUrl(key, { expiresIn = 900 } = {}) {
  if (DRIVER === "s3") {
    const k = String(key).replace(/^\/+/, "");
    const cmd = new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: k });
    return await getSignedUrl(s3, cmd, { expiresIn });
  }
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
    return await getSignedUrl(s3, cmd, { expiresIn });
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

module.exports = {
  DRIVER,
  isS3,
  uploadPrivate,
  uploadPublic,      // <-- added
  getPrivateUrl,
  getPublicUrl,      // <-- added
  getReadStreamAndMeta,
};
