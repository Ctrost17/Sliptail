// routes/downloads.js — works with STORAGE_DRIVER=local|s3
const express = require("express");
const path = require("path");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const storage = require("../storage");

const router = express.Router();

/* ---------- helpers ---------- */
async function getPurchasedFile(userId, productId) {
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
  if (!row.filename) return { error: "File not found", code: 404 };

  const key = String(row.filename); // may be "/uploads/..." (local) or "products/..." (s3)
  const filename = key.split("/").pop() || "download";
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

function setStreamHeaders(res, { asAttachment, filename, meta, isPartial }) {
  res.setHeader(
    "Content-Disposition",
    `${asAttachment ? "attachment" : "inline"}; filename="${filename}"`
  );
  res.setHeader("Content-Type", meta.contentType || "application/octet-stream");
  if (meta.acceptRanges) res.setHeader("Accept-Ranges", meta.acceptRanges);
  if (meta.contentRange) {
    res.status(206);
    res.setHeader("Content-Range", meta.contentRange);
  } else if (typeof meta.contentLength === "number") {
    res.setHeader("Content-Length", String(meta.contentLength));
  }
}

/* ---------- routes: purchases ---------- */

router.get("/view/:productId", requireAuth, async (req, res) => {
  const productId = Number(req.params.productId);
  const userId = req.user.id;
  try {
    const result = await getPurchasedFile(userId, productId);
    if (result.error) return res.status(result.code).json({ error: result.error });

    await recordDownload(result.orderId, productId);

    const meta = await storage.getReadStreamAndMeta(result.key, req.headers.range);
    setStreamHeaders(res, { asAttachment: false, filename: result.filename, meta });
    meta.stream.on("error", (e) => {
      console.error("stream error:", e);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    meta.stream.pipe(res);
  } catch (e) {
    console.error("download view error:", e);
    res.status(500).json({ error: "Download failed" });
  }
});

router.get("/file/:productId", requireAuth, async (req, res) => {
  const productId = Number(req.params.productId);
  const userId = req.user.id;
  try {
    const result = await getPurchasedFile(userId, productId);
    if (result.error) return res.status(result.code).json({ error: result.error });

    await recordDownload(result.orderId, productId);

    const meta = await storage.getReadStreamAndMeta(result.key, undefined);
    setStreamHeaders(res, { asAttachment: true, filename: result.filename, meta });
    meta.stream.on("error", (e) => {
      console.error("stream error:", e);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    meta.stream.pipe(res);
  } catch (e) {
    console.error("download file error:", e);
    res.status(500).json({ error: "Download failed" });
  }
});

/* ---------- routes: requests (buyer downloads delivered/complete) ---------- */

router.get("/request/:requestId", requireAuth, async (req, res) => {
  const requestId = Number(req.params.requestId);
  const userId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT cr.creator_attachment_path, cr.attachment_path, cr.status, cr.buyer_id
         FROM custom_requests cr
        WHERE cr.id = $1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });
    if (r.buyer_id !== userId) return res.status(403).json({ error: "Not your request" });

    const s = String(r.status || "").toLowerCase();
    if (!(s === "delivered" || s === "complete")) {
      return res.status(403).json({ error: "Not ready for download" });
    }

    const key = (r.creator_attachment_path || r.attachment_path || "").trim();
    if (!key) return res.status(404).json({ error: "No delivery file" });

    const filename = key.split("/").pop() || "delivery";
    const meta = await storage.getReadStreamAndMeta(key, undefined);

    setStreamHeaders(res, { asAttachment: true, filename, meta });
    meta.stream.on("error", (e) => {
      console.error("request stream error:", e);
      if (!res.headersSent) res.status(500);
      res.end();
    });
    meta.stream.pipe(res);
  } catch (e) {
    console.error("request download error:", e);
    res.status(500).json({ error: "Download failed" });
  }
});

module.exports = router;
