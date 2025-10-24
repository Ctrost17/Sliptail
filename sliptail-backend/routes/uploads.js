const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { requireAuth, requireCreator } = require("../middleware/auth");
const storage = require("../storage");

const router = express.Router();

function newPostKey(originalName) {
  const id = (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString("hex");
  const ext = path.extname(originalName || "");
  return `posts/${id}${ext}`;
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
  const { filename, contentType } = req.body || {};
  if (!filename || !contentType) return res.status(400).json({ error: "filename and contentType required" });

  try {
    // keep files grouped by user
    const ext = path.extname(filename || "") || ".bin";
    const key = `products/${req.user.id}/${crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")}${ext}`;
    const url = await storage.getPresignedPutUrl(key, { contentType, expiresIn: 3600 });
    res.json({ key, url, contentType });
  } catch (e) {
    console.error("presign-product error:", e);
    res.status(500).json({ error: "Could not presign product upload" });
  }
});

module.exports = router;
