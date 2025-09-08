// routes/downloads.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const uploadDir = path.join(__dirname, "..", "public", "uploads");

// --- helpers -------------------------------------------------------------

async function getPurchasedFile(userId, productId) {
  // must be a 'purchase' product & the user must have a PAID order for it
  const { rows } = await db.query(
    `SELECT p.filename, p.product_type, o.id AS order_id
       FROM products p
       JOIN orders   o ON o.product_id = p.id
      WHERE p.id = $1
        AND p.product_type = 'purchase'
        AND o.buyer_id = $2
        AND o.status = 'paid'
      LIMIT 1`,
    [productId, userId]
  );
  const row = rows[0];
  if (!row) return { error: "No access or not a purchase product", code: 403 };
  if (!row.filename) return { error: "File not found on server", code: 404 };

  const fullPath = path.join(uploadDir, row.filename);
  if (!fs.existsSync(fullPath)) return { error: "File missing on disk", code: 404 };

  return { orderId: row.order_id, filename: row.filename, fullPath };
}

async function recordDownload(orderId, productId) {
  // Keeps a counter & timestamp per (order, product). Safe to no-op if table absent.
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
    // don't fail the response just because analytics failed
    console.warn("download_access update skipped:", e.message);
  }
}

// --- routes: purchases ---------------------------------------------------

// 👀 View inline (PDF/image/video displayed in browser)
router.get("/view/:productId", requireAuth, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  const userId = req.user.id;

  const result = await getPurchasedFile(userId, productId);
  if (result.error) return res.status(result.code).json({ error: result.error });

  await recordDownload(result.orderId, productId);

  // Let the browser try to display it inline
  res.setHeader("Content-Disposition", `inline; filename="${result.filename}"`);
  return res.sendFile(result.fullPath);
});

// ⬇️ Download as attachment (forces “Save As…”)
router.get("/file/:productId", requireAuth, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  const userId = req.user.id;

  const result = await getPurchasedFile(userId, productId);
  if (result.error) return res.status(result.code).json({ error: result.error });

  await recordDownload(result.orderId, productId);

  return res.download(result.fullPath, result.filename);
});

// --- routes: requests (delivered files) ---------------------------------
// If your request flow stores the creator’s delivery on custom_requests.attachment_path
// and sets status='delivered', the buyer can grab it here.
router.get("/request/:requestId", requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.requestId, 10);
  const userId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT cr.attachment_path, cr.status, cr.buyer_id
         FROM custom_requests cr
        WHERE cr.id = $1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });

    // only the buyer can download, and only after delivered
    if (r.buyer_id !== userId) return res.status(403).json({ error: "Not your request" });
    if (r.status !== "delivered") return res.status(403).json({ error: "Not delivered yet" });

    if (!r.attachment_path) return res.status(404).json({ error: "No delivery file" });

    const fullPath = path.join(uploadDir, r.attachment_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "File missing on disk" });

    return res.download(fullPath, path.basename(r.attachment_path));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Download failed" });
  }
});

module.exports = router;