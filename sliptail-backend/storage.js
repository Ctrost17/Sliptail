// storage.js (CommonJS)
const fs = require("fs");
const path = require("path");

const DRIVER = (process.env.STORAGE_DRIVER || "local").toLowerCase();
const isS3 = DRIVER === "s3";

// -------- Local (disk) impl: writes under /public/uploads --------
const localRoot = path.join(__dirname, "public", "uploads");
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

async function localWritePublic({ key, body }) {
  // key like "creators/123/profile.jpg" or "products/123/file.mp4"
  const abs = path.join(localRoot, key);
  ensureDir(path.dirname(abs));
  await fs.promises.writeFile(abs, body);
  // public path served by Express static: /uploads/<key>
  return { key, url: `/uploads/${key.replace(/\\/g, "/")}` };
}
async function localWritePrivate({ key, body }) {
  // store under uploads/private to keep paths simple in dev;
  const abs = path.join(localRoot, "private", key);
  ensureDir(path.dirname(abs));
  await fs.promises.writeFile(abs, body);
  return { key, url: null };
}
function localPublicUrl(key) {
  return `/uploads/${String(key).replace(/\\/g, "/")}`;
}

// -------- S3 / Lightsail Object Storage impl --------
let s3 = null;
let PutObjectCommand = null;

if (isS3) {
  const { S3Client, PutObjectCommand: POC } = require("@aws-sdk/client-s3");
  PutObjectCommand = POC;

  s3 = new S3Client({
    region: process.env.S3_REGION || "us-east-2",
    endpoint: process.env.S3_ENDPOINT || undefined,          // Lightsail: set this
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || "true") === "true", // Lightsail: true
    credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
  });
}

const PUBLIC_BUCKET  = process.env.S3_PUBLIC_BUCKET  || "";
const PRIVATE_BUCKET = process.env.S3_PRIVATE_BUCKET || "";

// Build a public URL for a key. Prefer a CDN/base override if provided.
function s3PublicUrl(key) {
  // If you set a CDN/base like https://cdn.example.com, we’ll use that.
  const base =
    process.env.S3_PUBLIC_BASE_URL ||
    process.env.S3_PUBLIC_CDN ||
    // fallback best-effort (works with path-style endpoints too)
    (process.env.S3_ENDPOINT
      ? `${process.env.S3_ENDPOINT.replace(/\/+$/, "")}/${PUBLIC_BUCKET}`
      : `https://${PUBLIC_BUCKET}.s3.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com`);
  return `${base}/${String(key).replace(/^\/+/, "")}`;
}

async function s3Put({ bucket, key, body, contentType, acl }) {
  if (!s3) throw new Error("S3 client not initialized");
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || "application/octet-stream",
    ...(acl ? { ACL: acl } : {}), // For Lightsail public objects use "public-read"
  });
  await s3.send(cmd);
  return { key };
}

// ------------- Unified exported surface -------------
module.exports = {
  isS3,

  /**
   * Upload a file intended to be PRIVATE (downloads via signed route).
   * In S3: uploads to PRIVATE_BUCKET with no public ACL.
   * In local: writes under /public/uploads/private/<key>.
   */
  async uploadPrivate({ key, body, contentType }) {
    if (isS3) {
      if (!PRIVATE_BUCKET) throw new Error("S3_PRIVATE_BUCKET env is required");
      await s3Put({ bucket: PRIVATE_BUCKET, key, body, contentType });
      return { key };
    }
    return localWritePrivate({ key, body });
  },

  /**
   * Upload a file intended to be PUBLICLY VIEWABLE (images, avatars, etc).
   * In S3: uploads to PUBLIC_BUCKET with ACL public-read (Lightsail allows this).
   * In local: writes to /public/uploads/<key> and returns a public path.
   */
  async uploadPublic({ key, body, contentType }) {
    if (isS3) {
      if (!PUBLIC_BUCKET) throw new Error("S3_PUBLIC_BUCKET env is required");
      await s3Put({ bucket: PUBLIC_BUCKET, key, body, contentType, acl: "public-read" });
      const url = s3PublicUrl(key);
      return { key, url };
    }
    return localWritePublic({ key, body });
  },

  /**
   * Given a key (usually from uploadPublic), return a public URL.
   * Local: returns /uploads/<key>.  S3: builds a URL (or CDN/base if provided).
   */
  publicUrl(key) {
    return isS3 ? s3PublicUrl(key) : localPublicUrl(key);
  },
};