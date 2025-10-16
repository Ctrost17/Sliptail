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
  if (k.startsWith("requests/") || k.startsWith("products/")) return `uploads/${k}`;
  return `uploads/${k}`; // fallback
}

const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const LOCAL_UPLOADS_ROOT = process.env.LOCAL_UPLOADS_DIR || path.join(PUBLIC_DIR, "uploads");

/* -------------------- S3 DRIVER -------------------- */
let s3 = null;
let GetObjectCommand = null;
let PutObjectCommand = null;
let getSignedUrl = null;
let PRIVATE_BUCKET = null;
let S3_REGION = null;

if (DRIVER === "s3") {
  const { S3Client } = require("@aws-sdk/client-s3");
  ({ GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3"));
  ({ getSignedUrl } = require("@aws-sdk/s3-request-presigner"));

  S3_REGION = process.env.S3_REGION || "us-east-2";
  PRIVATE_BUCKET = process.env.S3_PRIVATE_BUCKET;
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

/* ==================== PUBLIC API ==================== */

/**
 * uploadPrivate({ key, contentType, body })
 * LOCAL: writes to public/uploads/<key>; returns { key: "/uploads/<key>" }
 * S3:   PutObject to bucket; returns { key }  (raw S3 key, e.g. "requests/123.mp4")
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
  const rel = key.replace(/^\/+/, "");
  const absDir = path.join(LOCAL_UPLOADS_ROOT, path.dirname(rel));
  const absPath = path.join(LOCAL_UPLOADS_ROOT, rel);
  await ensureDir(absDir);
  await fsp.writeFile(absPath, body);
  // Return /uploads/<key> so legacy checks pass
  return { key: `/uploads/${rel}` };
}

/**
 * getPrivateUrl(key, { expiresIn })
 * LOCAL: returns "/uploads/..." path.
 * S3:    returns presigned GET URL.
 */
async function getPrivateUrl(key, { expiresIn = 900 } = {}) {
  if (DRIVER === "s3") {
    const k = String(key).replace(/^\/+/, ""); // raw S3 key
    const cmd = new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: k });
    return await getSignedUrl(s3, cmd, { expiresIn });
  }
  const k = normalizeLocalKey(key);
  return `/${k}`;
}

/**
 * getReadStreamAndMeta(key, rangeHeader)
 * Returns: { stream, contentType, contentLength, contentRange, acceptRanges }
 * Works for both drivers. Caller sets headers and pipes stream.
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
      acceptRanges: data.AcceptRanges, // usually "bytes"
    };
  }

  // LOCAL
  const rel = normalizeLocalKey(key);
  const abs = path.join(PUBLIC_DIR, rel);
  const stat = fs.statSync(abs);

  let start = 0;
  let end = stat.size - 1;
  let contentRange = undefined;
  let streamOpts = {};

  if (rangeHeader && /^bytes=\d*-\d*$/.test(rangeHeader)) {
    const [s, e] = rangeHeader.replace("bytes=", "").split("-");
    if (s !== "") start = parseInt(s, 10);
    if (e !== "") end = parseInt(e, 10);
    if (start > end || start >= stat.size) {
      // invalid range; return whole file
      start = 0;
      end = stat.size - 1;
    } else {
      contentRange = `bytes ${start}-${end}/${stat.size}`;
      streamOpts = { start, end };
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
  getPrivateUrl,
  getReadStreamAndMeta,
};
