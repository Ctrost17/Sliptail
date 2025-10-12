// storage/local.js
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const mime = require('mime-types');

const ROOT = process.env.LOCAL_UPLOAD_ROOT || 'uploads'; // relative to project root
const PUBLIC_DIR = path.join(ROOT, 'public');
const PRIVATE_DIR = path.join(ROOT, 'private');

// Create dirs if missing
for (const dir of [ROOT, PUBLIC_DIR, PRIVATE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function slugify(name = '') {
  return name.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 120);
}

function uniqueName(original = 'file') {
  const base = slugify(original) || 'file';
  const id = crypto.randomBytes(6).toString('hex');
  // keep extension if present
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${stem}-${id}${ext}`;
}

async function writeFromInput(destFullPath, file) {
  await fsp.mkdir(path.dirname(destFullPath), { recursive: true });

  if (file?.buffer) {
    await fsp.writeFile(destFullPath, file.buffer);
  } else if (file?.path) {
    // move/copy from temp path
    await fsp.copyFile(file.path, destFullPath);
  } else {
    throw new Error('upload: provide {buffer} or {path}');
  }
}

function publicKeyToUrl(key) {
  // Prefer absolute API base if provided; else return a relative path.
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const relative = `/uploads/public/${key}`;
  return base ? `${base}${relative}` : relative;
}

function privateKeyToUrl(key) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const relative = `/uploads/private/${key}`;
  return base ? `${base}${relative}` : relative;
}

async function uploadPublic(file, opts = {}) {
  const name = uniqueName(file?.originalname || 'upload');
  const key = name; // flat; you could add dates: `yyyy/mm/${name}`
  const dest = path.join(PUBLIC_DIR, key);
  await writeFromInput(dest, file);
  return { key, url: publicKeyToUrl(key) };
}

async function uploadPrivate(file, opts = {}) {
  const name = uniqueName(file?.originalname || 'upload');
  const key = name;
  const dest = path.join(PRIVATE_DIR, key);
  await writeFromInput(dest, file);
  // In local mode we just return a direct path (no real signing).
  return { key, url: privateKeyToUrl(key) };
}

function getPublicUrl(key) {
  return publicKeyToUrl(key);
}

function getPrivateUrl(key /* , opts */) {
  // In local dev this is direct; in prod (S3) it’s presigned.
  return privateKeyToUrl(key);
}

async function deletePublic(key) {
  const p = path.join(PUBLIC_DIR, key);
  try { await fsp.unlink(p); } catch { /* ignore */ }
}

async function deletePrivate(key) {
  const p = path.join(PRIVATE_DIR, key);
  try { await fsp.unlink(p); } catch { /* ignore */ }
}

module.exports = {
  driver: 'local',
  uploadPublic,
  uploadPrivate,
  getPublicUrl,
  getPrivateUrl,
  deletePublic,
  deletePrivate,
};