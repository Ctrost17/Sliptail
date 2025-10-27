// routes/downloads.js — works with STORAGE_DRIVER=local|s3
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const storage = require("../storage");

const router = express.Router();

/* ---------- helpers ---------- */
async function getPurchasedFile(userId, productId) {
  const { rows } = await db.query(
    `SELECT p.filename, p.product_type, p.title, o.id AS order_id
       FROM products p
       JOIN orders   o ON o.product_id = p.id
      WHERE p.id = $1
        AND p.product_type = 'purchase'
        AND o.buyer_id = $2
        AND o.status IN ('paid','completed','succeeded','success')
      LIMIT 1`,
    [productId, userId]
  );

  const row = rows[0];
  if (!row) return { error: "No access or not a purchase product", code: 403 };
  if (!row.filename) return { error: "File not found", code: 404 };

  const key = storage.keyFromPublicUrl(row.filename);
  const fallback = key.split("/").pop() || "download";
  const filename = (row.title ? String(row.title).trim() : fallback) || fallback;
  return { orderId: row.order_id, key, filename };
}

async function recordDownload(orderId, productId) {
  try {
    await db.query(
      `INSERT INTO download_access(order_id, product_id, downloads, last_download_at)
       VALUES ($1,$2,1,NOW())
       ON CONFLICT (order_id, product_id)
       DO UPDATE SET downloads = download_access.downloads + 1,
                     last_download_at = NOW()`,
      [orderId, productId]
    );
  } catch (e) {
    console.warn("download_access update skipped:", e.message);
  }
}

/* ---------- purchases: INLINE PREVIEW ---------- */
router.get("/view/:productId", requireAuth, async (req, res) => {
  const productId = String(req.params.productId).trim();
  const userId = String(req.user.id);

  try {
    const result = await getPurchasedFile(userId, productId);
    if (result.error) return res.status(result.code).json({ error: result.error });

    await recordDownload(result.orderId, productId);

    // Optionally detect true content-type from storage
    let ct = null;
    try { const head = await storage.headPrivate(result.key); ct = head.contentType || null; } catch {}

    const url = await storage.getSignedDownloadUrl(result.key, {
      filename: result.filename,
      expiresSeconds: 120,
      disposition: "inline",
      contentType: ct,
    });

    res.set("Cache-Control", "no-store");
    return res.redirect(302, url);
  } catch (e) {
    console.error("download view error:", e);
    res.status(500).json({ error: "Download failed" });
  }
});

/* ---------- purchases: ATTACHMENT (SAVE AS) ---------- */
router.get("/file/:productId", requireAuth, async (req, res) => {
  const productId = String(req.params.productId).trim();
  const userId = String(req.user.id);
  try {
    const result = await getPurchasedFile(userId, productId);
    if (result.error) return res.status(result.code).json({ error: result.error });

    await recordDownload(result.orderId, productId);

    const url = await storage.getSignedDownloadUrl(result.key, {
      filename: result.filename,
      expiresSeconds: 120,
      disposition: "attachment",
    });

    res.set("Cache-Control", "no-store");
    return res.redirect(302, url);
  } catch (e) {
    console.error("download file error:", e);
    res.status(500).json({ error: "Download failed" });
  }
});

/* ---------- requests: buyer downloads delivered/complete ---------- */
router.get("/request/:requestId", requireAuth, async (req, res) => {
  const requestId = String(req.params.requestId).trim();
  const userId = String(req.user.id);

  try {
    const { rows } = await db.query(
      `SELECT cr.creator_attachment_path, cr.attachment_path, cr.status, cr.buyer_id, cr.title
         FROM custom_requests cr
        WHERE cr.id = $1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });
    if (String(r.buyer_id) !== userId) return res.status(403).json({ error: "Not your request" });

    const s = String(r.status || "").toLowerCase();
    if (!(s === "delivered" || s === "complete" || s === "completed")) {
      return res.status(403).json({ error: "Not ready for download" });
    }

    const raw = (r.creator_attachment_path || r.attachment_path || "").trim();
    const key = storage.keyFromPublicUrl(raw);
    if (!key) return res.status(404).json({ error: "No delivery file" });

    const fallback = key.split("/").pop() || "delivery";
    const filename = (r.title ? String(r.title).trim() : fallback) || fallback;

    const url = await storage.getSignedDownloadUrl(key, {
      filename,
      expiresSeconds: 120,
      disposition: "attachment",
    });

    res.set("Cache-Control", "no-store");
    return res.redirect(302, url);
  } catch (e) {
    console.error("request download error:", e);
    res.status(500).json({ error: "Download failed" });
  }
});

module.exports = router;

