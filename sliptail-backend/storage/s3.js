// storage/s3.js
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const mime = require('mime-types');

const REGION = process.env.S3_REGION;
const ENDPOINT = process.env.S3_ENDPOINT; // optional
const FORCE_PATH_STYLE = String(process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true';
const ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;

const PUBLIC_BUCKET = process.env.PUBLIC_BUCKET;
const PRIVATE_BUCKET = process.env.PRIVATE_BUCKET;

const DEFAULT_PRESIGN = Number(process.env.S3_PRESIGN_EXPIRES || 900); // seconds

const s3 = new S3Client({
  region: REGION,
  endpoint: ENDPOINT || undefined,
  forcePathStyle: FORCE_PATH_STYLE || !!ENDPOINT, // path-style is safe for Lightsail
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
});

function todayPrefix() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

function slugify(name = '') {
  return name.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 120);
}

function uniqueKey(original = 'file') {
  const base = slugify(original) || 'file';
  const id = crypto.randomBytes(6).toString('hex');
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${todayPrefix()}/${stem}-${id}${ext}`;
}

async function putObject({ bucket, key, body, contentType }) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
    // For public objects, we rely on a BUCKET POLICY that grants public read,
    // instead of per-object ACLs (keeps ACLs simple/off).
  }));
}

async function uploadCommon(bucket, file, opts = {}) {
  const key = opts.key || uniqueKey(file?.originalname || 'upload');
  const contentType =
    file?.mimetype ||
    mime.lookup(file?.originalname || '') ||
    'application/octet-stream';

  // accept {buffer} or {path}
  let body;
  if (file?.buffer) {
    body = file.buffer;
  } else if (file?.path) {
    // read stream to avoid buffering large files in memory
    body = require('fs').createReadStream(file.path);
  } else {
    throw new Error('upload: provide {buffer} or {path}');
  }

  await putObject({ bucket, key, body, contentType });

  return { key, bucket };
}

// ---------- Public ----------
async function uploadPublic(file, opts = {}) {
  const { key, bucket } = await uploadCommon(PUBLIC_BUCKET, file, opts);
  return { key, bucket, url: getPublicUrl(key) };
}

function getPublicUrl(key) {
  // Use virtual-hosted–style URL if available
  // If you set S3_ENDPOINT for Lightsail, we synthesize a URL from it.
  // Otherwise, fall back to standard S3 pattern.
  const endpoint = (process.env.S3_PUBLIC_BASE || process.env.S3_ENDPOINT || '').replace(/\/$/, '');
  if (endpoint && endpoint.includes('http')) {
    // If endpoint is like https://s3.us-east-2.amazonaws.com we can build: https://PUBLIC_BUCKET.s3.us-east-2.amazonaws.com/key
    // But Lightsail/S3-compatible endpoints often also work with path-style; safer universal form:
    return `${endpoint}/${PUBLIC_BUCKET}/${encodeURI(key)}`;
  }
  // AWS default virtual-hosted–style
  return `https://${PUBLIC_BUCKET}.s3.${REGION}.amazonaws.com/${encodeURI(key)}`;
}

// ---------- Private ----------
async function uploadPrivate(file, opts = {}) {
  const { key, bucket } = await uploadCommon(PRIVATE_BUCKET, file, opts);
  const url = await getPrivateUrl(key, { expiresIn: opts.expiresIn });
  return { key, bucket, url };
}

async function getPrivateUrl(key, opts = {}) {
  const expiresIn = Math.max(30, Number(opts.expiresIn || DEFAULT_PRESIGN));
  const cmd = new PutObjectCommand({}); // just to reuse type; we'll actually sign a GET
  // Note: For GET you must use a GetObjectCommand (typo safety):
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const command = new GetObjectCommand({
    Bucket: PRIVATE_BUCKET,
    Key: key,
  });
  const url = await getSignedUrl(s3, command, { expiresIn });
  return url;
}

// ---------- Delete ----------
async function deletePublic(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: PUBLIC_BUCKET, Key: key }));
}

async function deletePrivate(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: PRIVATE_BUCKET, Key: key }));
}

module.exports = {
  driver: 's3',
  uploadPublic,
  uploadPrivate,
  getPublicUrl,
  getPrivateUrl,
  deletePublic,
  deletePrivate,
};
