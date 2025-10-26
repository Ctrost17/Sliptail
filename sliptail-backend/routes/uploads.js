const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { requireAuth, requireCreator } = require("../middleware/auth");
const storage = require("../storage");
const { buildDisposition } = require("../utils/disposition");

const router = express.Router();

function newPostKey(originalName) {
  const id = (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString("hex");
  const ext = path.extname(originalName || "");
  return `posts/${id}${ext}`;
}

function newRequestKey(originalName) {
  const id = (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString("hex");
  const ext = path.extname(originalName || "");
  return `requests/${id}${ext}`;
}


/**
 * POST /api/uploads/presign-post
 * Body: { filename: string, contentType: string }
 * Returns: { key, url, contentType }
 */
router.post("/presign-post", requireAuth, requireCreator, async (req, res) => {
  const { filename, contentType } = req.body || {};
  if (!filename || !contentType) return res.status(400).json({ error: "filename and contentType required" });

  try {
    const key = newPostKey(filename);
    const url = await storage.getPresignedPutUrl(key, { contentType, expiresIn: 3600 });
    res.json({ key, url, contentType });
  } catch (e) {
    console.error("presign error:", e);
    res.status(500).json({ error: "Could not presign upload" });
  }
});

router.post("/presign-product", requireAuth, requireCreator, async (req, res) => {
  const { filename, contentType, downloadName } = req.body || {};
  if (!filename || !contentType) return res.status(400).json({ error: "filename and contentType required" });

  try {
    // keep files grouped by user
    const ext = path.extname(filename || "") || ".bin";
    const key = `products/${req.user.id}/${crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")}${ext}`;
    const contentDisposition = buildDisposition("attachment", downloadName || filename);
    const url = await storage.getPresignedPutUrl(key, { contentType, expiresIn: 3600 });
    res.json({ key, url, contentType });
  } catch (e) {
    console.error("presign-product error:", e);
    res.status(500).json({ error: "Could not presign product upload" });
  }
});

/**
 * POST /api/uploads/presign-request
 * Body: { filename: string, contentType: string }
 * Returns: { key, url, contentType }
 */
router.post("/presign-request", requireAuth, async (req, res) => {
  const { filename, contentType, downloadName } = req.body || {};
  if (!filename || !contentType) {
    return res.status(400).json({ error: "filename and contentType required" });
  }
  try {
    const key = newRequestKey(filename);
    const contentDisposition = buildDisposition("attachment", downloadName || filename);
    const url = await storage.getPresignedPutUrl(key, { contentType, expiresIn: 3600 });
    res.json({ key, url, contentType });
  } catch (e) {
    console.error("presign-request error:", e);
    res.status(500).json({ error: "Could not presign request upload" });
  }
});

module.exports = router;
