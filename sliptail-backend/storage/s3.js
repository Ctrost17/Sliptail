// storage/s3.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mime = require("mime-types");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

/* ---------- ENV ---------- */
const REGION = process.env.S3_REGION || "us-east-2";
// For standard S3 leave ENDPOINT undefined and path-style false
const ENDPOINT = process.env.S3_ENDPOINT || undefined;
const FORCE_PATH_STYLE =
  String(process.env.S3_FORCE_PATH_STYLE || "").toLowerCase() === "true";

// Buckets
const PUBLIC_BUCKET = process.env.S3_PUBLIC_BUCKET;   // e.g. sliptail-public-01
const PRIVATE_BUCKET = process.env.S3_PRIVATE_BUCKET; // e.g. sliptail-private-01

// Optional: override the public URL base (useful for CDNs)
const PUBLIC_URL_BASE = process.env.S3_PUBLIC_URL_BASE || "";

// Credentials (separate users/keys is good practice)
const PUB_KEY    = process.env.S3_PUBLIC_ACCESS_KEY_ID || "";
const PUB_SECRET = process.env.S3_PUBLIC_SECRET_ACCESS_KEY || "";
const PRI_KEY    = process.env.S3_PRIVATE_ACCESS_KEY_ID || "";
const PRI_SECRET = process.env.S3_PRIVATE_SECRET_ACCESS_KEY || "";

// Presign expiry (seconds)
const DEFAULT_PRESIGN = Math.max(
  30,
  Number(process.env.S3_PRESIGN_EXPIRES || 900)
);

/* ---------- Clients ---------- */
function makeClient({ key, secret }) {
  const base = {
    region: REGION,
    credentials: key && secret ? { accessKeyId: key, secretAccessKey: secret } : undefined,
  };
  // Only set endpoint/path-style if you *really* need it (e.g., Lightsail MinIO).
  if (ENDPOINT) {
    base.endpoint = ENDPOINT;
    base.forcePathStyle = FORCE_PATH_STYLE || true;
  }
  return new S3Client(base);
}

const publicS3  = makeClient({ key: PUB_KEY, secret: PUB_SECRET });
const privateS3 = makeClient({ key: PRI_KEY, secret: PRI_SECRET });

/* ---------- Helpers ---------- */
function todayPrefix() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

function slugify(name = "") {
  return name
    .toLowerCase()
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

function uniqueKey(original = "file") {
  const base = slugify(original) || "file";
  const id = crypto.randomBytes(6).toString("hex");
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${todayPrefix()}/${stem}-${id}${ext}`;
}

async function putObject({ s3, bucket, key, body, contentType }) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    })
  );
}

async function uploadCommon(s3, bucket, file, opts = {}) {
  const key = opts.key || uniqueKey(file?.originalname || "upload");
  const contentType =
    file?.mimetype || mime.lookup(file?.originalname || "") || "application/octet-stream";

  let body;
  if (file?.buffer) body = file.buffer;
  else if (file?.path) body = fs.createReadStream(file.path);
  else throw new Error("upload: provide {buffer} or {path}");

  await putObject({ s3, bucket, key, body, contentType });
  return { key, bucket };
}

/* ---------- Public ---------- */
async function uploadPublic(file, opts = {}) {
  if (!PUBLIC_BUCKET) throw new Error("S3_PUBLIC_BUCKET missing");
  const { key, bucket } = await uploadCommon(publicS3, PUBLIC_BUCKET, file, opts);
  return { key, bucket, url: getPublicUrl(key) };
}

function getPublicUrl(key) {
  if (PUBLIC_URL_BASE) {
    return `${PUBLIC_URL_BASE.replace(/\/$/, "")}/${encodeURI(key)}`;
  }
  // Standard S3 virtual-hosted style
  return `https://${PUBLIC_BUCKET}.s3.${REGION}.amazonaws.com/${encodeURI(key)}`;
}

/* ---------- Private ---------- */
async function uploadPrivate(file, opts = {}) {
  if (!PRIVATE_BUCKET) throw new Error("S3_PRIVATE_BUCKET missing");
  const { key, bucket } = await uploadCommon(privateS3, PRIVATE_BUCKET, file, opts);
  const url = await getPrivateUrl(key, { expiresIn: opts.expiresIn });
  return { key, bucket, url };
}

async function getPrivateUrl(key, opts = {}) {
  const expiresIn = Math.max(30, Number(opts.expiresIn || DEFAULT_PRESIGN));
  const command = new GetObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key });
  return getSignedUrl(privateS3, command, { expiresIn });
}

/* ---------- Delete ---------- */
async function deletePublic(key) {
  await publicS3.send(new DeleteObjectCommand({ Bucket: PUBLIC_BUCKET, Key: key }));
}

async function deletePrivate(key) {
  await privateS3.send(new DeleteObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key }));
}

module.exports = {
  driver: "s3",
  uploadPublic,
  uploadPrivate,
  getPublicUrl,
  getPrivateUrl,
  deletePublic,
  deletePrivate,
};
