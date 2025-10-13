// storage.js (CommonJS) — standard S3 version
const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const DRIVER = (process.env.STORAGE_DRIVER || "local").toLowerCase();
const isS3 = DRIVER === "s3";

/* ---------------- Local impl ---------------- */
const localRoot = path.join(__dirname, "public", "uploads");
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
async function localWritePublic({ key, body }) {
  const abs = path.join(localRoot, key);
  ensureDir(path.dirname(abs));
  await fs.promises.writeFile(abs, body);
  return { key, url: `/uploads/${key.replace(/\\/g, "/")}` };
}
async function localWritePrivate({ key, body }) {
  const abs = path.join(localRoot, "private", key);
  ensureDir(path.dirname(abs));
  await fs.promises.writeFile(abs, body);
  return { key, url: null };
}
function localPublicUrl(key) { return `/uploads/${String(key).replace(/\\/g, "/")}`; }

/* ---------------- S3 impl ---------------- */
const S3_REGION = process.env.S3_REGION || "us-east-2";

// Buckets
const S3_PUBLIC_BUCKET  = process.env.S3_PUBLIC_BUCKET  || process.env.PUBLIC_BUCKET  || "";
const S3_PRIVATE_BUCKET = process.env.S3_PRIVATE_BUCKET || process.env.PRIVATE_BUCKET || "";

// Optional CDN/base for public URLs
const S3_PUBLIC_URL_BASE =
  process.env.S3_PUBLIC_URL_BASE ||
  process.env.S3_PUBLIC_BASE_URL ||
  process.env.S3_PUBLIC_CDN || "";

// Use separate creds (recommended). If you only made one IAM user, set both pairs the same.
const PUBLIC_CREDS = (process.env.S3_PUBLIC_ACCESS_KEY_ID && process.env.S3_PUBLIC_SECRET_ACCESS_KEY)
  ? { accessKeyId: process.env.S3_PUBLIC_ACCESS_KEY_ID, secretAccessKey: process.env.S3_PUBLIC_SECRET_ACCESS_KEY }
  : undefined;

const PRIVATE_CREDS = (process.env.S3_PRIVATE_ACCESS_KEY_ID && process.env.S3_PRIVATE_SECRET_ACCESS_KEY)
  ? { accessKeyId: process.env.S3_PRIVATE_ACCESS_KEY_ID, secretAccessKey: process.env.S3_PRIVATE_SECRET_ACCESS_KEY }
  : PUBLIC_CREDS; // fall back to public creds if you intentionally use one user

// IMPORTANT: No endpoint, no forcePathStyle for standard S3
const s3Public  = isS3 ? new S3Client({ region: S3_REGION,  credentials: PUBLIC_CREDS  }) : null;
const s3Private = isS3 ? new S3Client({ region: S3_REGION,  credentials: PRIVATE_CREDS }) : null;

function s3PublicUrl(key) {
  if (S3_PUBLIC_URL_BASE) {
    return `${S3_PUBLIC_URL_BASE.replace(/\/+$/, "")}/${String(key).replace(/^\/+/, "")}`;
  }
  // Standard virtual-hosted style URL
  return `https://${S3_PUBLIC_BUCKET}.s3.${S3_REGION}.amazonaws.com/${String(key).replace(/^\/+/, "")}`;
}

async function s3Put(s3, { bucket, key, body, contentType }) {
  if (!s3) throw new Error("S3 client not initialized");
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || "application/octet-stream",
    // NOTE: No ACL here. Use bucket policy to allow public GETs.
  });
  await s3.send(cmd);
  return { key };
}

/* ------------- Unified API ------------- */
module.exports = {
  isS3,

  async uploadPrivate({ key, body, contentType }) {
    if (isS3) {
      if (!S3_PRIVATE_BUCKET) throw new Error("S3_PRIVATE_BUCKET env is required");
      await s3Put(s3Private, { bucket: S3_PRIVATE_BUCKET, key, body, contentType });
      return { key }; // private; fetch via presigned route elsewhere
    }
    return localWritePrivate({ key, body });
  },

  async uploadPublic({ key, body, contentType }) {
    if (isS3) {
      if (!S3_PUBLIC_BUCKET) throw new Error("S3_PUBLIC_BUCKET env is required");
      await s3Put(s3Public, { bucket: S3_PUBLIC_BUCKET, key, body, contentType });
      return { key, url: s3PublicUrl(key) };
    }
    return localWritePublic({ key, body });
  },

  publicUrl(key) {
    return isS3 ? s3PublicUrl(key) : localPublicUrl(key);
  },
};
