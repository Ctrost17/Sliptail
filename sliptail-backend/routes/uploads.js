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

router.post("/presign-product", requireAuth, async (req, res) => {
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

/**
 * POST /api/uploads/presign-request-guest
 * Body: { session_id: string, filename: string, contentType: string }
 *
 * Allows a Stripe guest checkout buyer (not logged in) to upload an attachment for a
 * request they just purchased.
 *
 * Security:
 * - session_id must map to a PAID order
 * - the order must be a request-type product
 * - the order's buyer must be a webhook-created "guest_..." user
 */
router.post("/presign-request-guest", async (req, res) => {
  const { session_id, filename, contentType } = req.body || {};
  const sid = String(session_id || "").trim();
  if (!sid || !filename || !contentType) {
    return res.status(400).json({ error: "session_id, filename and contentType required" });
  }

  try {
    const db = require("../db");

    const { rows } = await db.query(
      `SELECT o.id AS order_id,
              o.status AS order_status,
              o.buyer_id,
              p.product_type,
              u.password_hash
         FROM public.orders o
         JOIN public.products p ON p.id = o.product_id
         JOIN public.users u ON u.id = o.buyer_id
        WHERE o.stripe_checkout_session_id = $1
        LIMIT 1`,
      [sid]
    );

    const row = rows[0];
    if (!row) return res.status(404).json({ error: "Order not found for this session" });
    if (row.order_status !== "paid") return res.status(400).json({ error: "Order is not paid yet" });
    if (row.product_type !== "request") return res.status(400).json({ error: "Not a request-type product" });

    const ph = String(row.password_hash || "");
    if (!ph.startsWith("guest_")) {
      return res.status(403).json({ error: "Please log in to upload attachments." });
    }

    const key = newRequestKey(filename);
    const url = await storage.getPresignedPutUrl(key, { contentType, expiresIn: 3600 });
    return res.json({ key, url, contentType });
  } catch (e) {
    console.error("presign-request-guest error:", e);
    return res.status(500).json({ error: "Could not presign request upload" });
  }
});

module.exports = router;
