// routes/downloads.js
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const {
  S3Client,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");

const router = express.Router();

/* ---------- S3 (private bucket) ---------- */
const REGION = process.env.S3_REGION || "us-east-2";
const PRIVATE_BUCKET = process.env.S3_PRIVATE_BUCKET;
if (!PRIVATE_BUCKET) {
  throw new Error("S3_PRIVATE_BUCKET is required");
}

const s3 = new S3Client({
  region: REGION,
  credentials: (process.env.S3_PRIVATE_ACCESS_KEY_ID && process.env.S3_PRIVATE_SECRET_ACCESS_KEY)
    ? {
        accessKeyId: process.env.S3_PRIVATE_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_PRIVATE_SECRET_ACCESS_KEY,
      }
    : undefined,
});

/* ---------- helpers ---------- */

// Returns { orderId, key, filename } or { error, code }
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

  // In S3 mode, p.filename is the S3 KEY (e.g. "products/123/file.zip")
  const key = row.filename;
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

// Stream an S3 object to the response.
// If "asAttachment" true, forces save dialog.
async function streamS3Object({ key, res, asAttachment, filename, rangeHeader }) {
  const params = {
    Bucket: PRIVATE_BUCKET,
    Key: key,
    ...(rangeHeader ? { Range: rangeHeader } : {}),
  };

  const cmd = new GetObjectCommand(params);
  const data = await s3.send(cmd);

  // Content headers from S3
  const contentType = data.ContentType || "application/octet-stream";
  const contentLength = data.ContentLength;
  const contentRange = data.ContentRange; // present when Range used
  const acceptRanges = data.AcceptRanges; // usually "bytes"

  if (asAttachment) {
    // force browser download (no navigation)
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  } else {
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  }

  res.setHeader("Content-Type", contentType);
  if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);
  if (contentRange) {
    res.status(206);
    res.setHeader("Content-Range", contentRange);
  } else if (typeof contentLength === "number") {
    res.setHeader("Content-Length", String(contentLength));
  }

  // Stream the S3 body to the client
  data.Body.on("error", (e) => {
    console.error("S3 stream error:", e);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  data.Body.pipe(res);
}

/* ---------- routes: purchases ---------- */

// View inline (PDF/image/video). Still streamed; set asAttachment=false.
router.get("/view/:productId", requireAuth, async (req, res) => {
  const productId = Number(req.params.productId);
  const userId = req.user.id;

  try {
    const result = await getPurchasedFile(userId, productId);
    if (result.error) return res.status(result.code).json({ error: result.error });

    await recordDownload(result.orderId, productId);

    const range = req.headers.range; // support seeking
    await streamS3Object({
      key: result.key,
      res,
      asAttachment: false,
      filename: result.filename,
      rangeHeader: range,
    });
  } catch (e) {
    console.error("download view error:", e);
    res.status(500).json({ error: "Download failed" });
  }
});

// Download as attachment (Save As…)
router.get("/file/:productId", requireAuth, async (req, res) => {
  const productId = Number(req.params.productId);
  const userId = req.user.id;

  try {
    const result = await getPurchasedFile(userId, productId);
    if (result.error) return res.status(result.code).json({ error: result.error });

    await recordDownload(result.orderId, productId);

    await streamS3Object({
      key: result.key,
      res,
      asAttachment: true,
      filename: result.filename,
      rangeHeader: undefined, // downloads usually don’t need Range
    });
  } catch (e) {
    console.error("download file error:", e);
    res.status(500).json({ error: "Download failed" });
  }
});

/* ---------- routes: requests (delivered files) ---------- */
router.get("/request/:requestId", requireAuth, async (req, res) => {
  const requestId = Number(req.params.requestId);
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
    if (r.buyer_id !== userId) return res.status(403).json({ error: "Not your request" });
    if (r.status !== "delivered") return res.status(403).json({ error: "Not delivered yet" });
    if (!r.attachment_path) return res.status(404).json({ error: "No delivery file" });

    const key = r.attachment_path; // stored as S3 key
    const filename = key.split("/").pop() || "delivery";

    await streamS3Object({
      key,
      res,
      asAttachment: true,
      filename,
      rangeHeader: undefined,
    });
  } catch (e) {
    console.error("request download error:", e);
    res.status(500).json({ error: "Download failed" });
  }
});

module.exports = router;
