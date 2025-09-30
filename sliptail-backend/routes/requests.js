const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, requireCreator } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { requestCreate, requestDecision, requestDeliver } = require("../validators/schemas");
const { strictLimiter, standardLimiter } = require("../middleware/rateLimit");
const { notifyRequestDelivered, notifyCreatorNewRequest } = require("../utils/notify");
const { needsTranscode, transcodeToMp4 } = require("../utils/video");

// NEW: in-app notifications service (writes to notifications.metadata)
const { notify } = require("../services/notifications");

const router = express.Router();

// Allow configurable initial status; default to legacy 'open' to satisfy current DB constraint
const REQUEST_INITIAL_STATUS = process.env.REQUEST_INITIAL_STATUS || "open";

// Normalize legacy DB status 'open' to 'pending' for API consumers
function normalizeStatus(row) {
  if (!row) return row;
  if (row.status === "open") return { ...row, status: "pending" };
  return row;
}

/* ---------- Upload setup (must be defined before routes use it) ---------- */

// store attachments in the same uploads folder you already use
const uploadDir = path.join(__dirname, "..", "public", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Dedicated subfolder for creator-delivered/request media
const uploadDirRequests = path.join(uploadDir, "requests");
if (!fs.existsSync(uploadDirRequests)) fs.mkdirSync(uploadDirRequests, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `req-${Date.now()}${ext}`);
  },
});

const allowed = new Set([
  "application/pdf",
  "application/epub+zip",
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "text/plain",
]);

const upload = multer({
  storage,
  limits: { fileSize: 2500 * 1024 * 1024 }, // 2.5GB max
  fileFilter: (req, file, cb) => {
    if (!allowed.has(file.mimetype)) {
      return cb(new Error("Unsupported file type"));
    }
    cb(null, true);
  },
});

// Multer instance for creator media: saves to /public/uploads/requests with random filenames
const creatorStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDirRequests),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const id = (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString("hex");
    cb(null, `${id}${ext}`);
  },
});

const uploadCreator = multer({
  storage: creatorStorage,
  limits: { fileSize: 2500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowed.has(file.mimetype)) {
      return cb(new Error("Unsupported file type"));
    }
    cb(null, true);
  },
});

/* --------------------------- Helper functions --------------------------- */

// Ensure a product is a 'request' product that belongs to creator_id
async function getRequestProduct(productId, creatorId) {
  const { rows } = await db.query(
    `SELECT id, user_id AS creator_id, product_type, price
       FROM products
      WHERE id = $1`,
    [productId]
  );
  const p = rows[0];
  if (!p) return { error: "Product not found", code: 404 };
  if (p.creator_id !== creatorId) return { error: "Product does not belong to this creator", code: 400 };
  if (p.product_type !== "request") return { error: "Product is not a request type", code: 400 };
  return { ok: true, product: p };
}

// Returns true if a notification for (user_id,type,request_id) already exists
async function alreadyNotified(userId, type, requestId) {
  try {
    const { rows } = await db.query(
      `SELECT 1
         FROM notifications
        WHERE user_id = $1
          AND type = $2
          AND (metadata->>'request_id') = $3
        LIMIT 1`,
      [Number(userId), String(type), String(requestId)]
    );
    return rows.length > 0;
  } catch (e) {
    console.error("alreadyNotified check failed:", e?.message || e);
    // fail-open so notifications don't silently stop if DB hiccups
    return false;
  }
}

/* -------------------------------- Routes -------------------------------- */

/**
 * BUYER creates a request for a specific creator + request product
 * Body fields:
 *  - creator_id (int)  -> the seller receiving the request
 *  - product_id (int)  -> the creator's product with product_type='request'
 *  - message (text)    -> buyer's details
 * Optional file field: "attachment"
 *
 * Creates:
 *  - orders row (status='pending', amount from product price)
 *  - custom_requests row (status='pending'|'open', with optional attachment_path)
 *
 * Later, Stripe webhook will set orders.status='paid'.
 */
router.post(
  "/create",
  requireAuth,
  strictLimiter, // sensitive (creates an order)
  upload.single("attachment"),
  validate(requestCreate),
  async (req, res) => {
    const buyerId = req.user.id;
    const { creator_id, product_id, message } = req.body;

    // basic checks
    if (Number(creator_id) === buyerId) {
      return res.status(400).json({ error: "You cannot request your own product" });
    }

    // attachment path if provided (store only basename)
    const attachment_path = req.file ? `/uploads/${path.basename(req.file.path)}` : null;

    try {
      // 1) validate that product_id is a request product of this creator
      const v = await getRequestProduct(Number(product_id), Number(creator_id));
      if (v.error) return res.status(v.code).json({ error: v.error });

      const amount = Number(v.product.price ?? 0);
      if (Number.isNaN(amount) || amount < 0) {
        return res.status(400).json({ error: "Invalid product price" });
      }

      // 2) Do both writes atomically
      await db.query("BEGIN");

      // create order (pending)
      const { rows: orderRows } = await db.query(
        `INSERT INTO orders (buyer_id, product_id, amount, status, created_at)
         VALUES ($1, $2, $3, 'pending', NOW())
         RETURNING *`,
        [buyerId, product_id, amount]
      );
      const order = orderRows[0];

      // create custom_requests (pending or 'open' depending on env)
      const { rows: reqRows } = await db.query(
        `INSERT INTO custom_requests (order_id, buyer_id, creator_id, "user", creator, attachment_path, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING *`,
        [order.id, buyerId, creator_id, message || null, null, attachment_path, REQUEST_INITIAL_STATUS]
      );
      const request = reqRows[0];

      await db.query("COMMIT");

      // respond to client
      res.status(201).json({ success: true, order, request: normalizeStatus(request) });

        // in-app + email to creator — only once per request
        if (!(await alreadyNotified(Number(creator_id), "creator_request", request.id))) {
          notify(
            Number(creator_id),
            "creator_request",
            "You’ve got a new custom request! 🎉",
            "Check out the details on your creator dashboard and let your creativity shine",
            { request_id: request.id }
          ).catch(console.error);

          notifyCreatorNewRequest({ requestId: request.id }).catch(console.error);
        }
    } catch (err) {
      try {
        await db.query("ROLLBACK");
      } catch {}
      console.error("Create request error:", err);
      res.status(500).json({ error: "Failed to create request" });
    }
  }
);

/**
 * (Alt) POST /api/requests
 * Body (multipart/form-data): { orderId, details?, attachment? }
 * Used by older frontend that already has an order (paid or pending for request type).
 * If the order/product is not a request product, rejects.
 */
router.post("/", requireAuth, strictLimiter, upload.single("attachment"), async (req, res) => {
  const buyerId = req.user.id;
  const orderId = parseInt(String(req.body.orderId || req.body.order_id || "").trim(), 10);
  const details = (req.body.details || req.body.message || "").toString();
  if (!orderId) return res.status(400).json({ ok: false, error: "orderId required" });

  try {
    const { rows } = await db.query(
      `SELECT o.id AS order_id, o.buyer_id, o.product_id, o.status,
              p.product_type, p.user_id AS creator_id
         FROM orders o
         JOIN products p ON p.id = o.product_id
        WHERE o.id=$1 AND o.buyer_id=$2
        LIMIT 1`,
      [orderId, buyerId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ ok: false, error: "Order not found" });
    if (row.product_type !== "request") return res.status(400).json({ ok: false, error: "Not a request order" });

    const attachment_path = req.file ? `/uploads/${path.basename(req.file.path)}` : null;

    const { rows: existing } = await db.query(
      `SELECT id FROM custom_requests WHERE order_id=$1 AND buyer_id=$2`,
      [orderId, buyerId]
    );

    let requestId;
    if (existing.length) {
      const { rows: upd } = await db.query(
        `UPDATE custom_requests
            SET "user" = COALESCE($2, "user"),
                attachment_path = COALESCE($3, attachment_path)
          WHERE id=$1
        RETURNING id`,
        [existing[0].id, details || null, attachment_path]
      );
      requestId = upd[0].id;
    } else {
      const { rows: ins } = await db.query(
        `INSERT INTO custom_requests (order_id, buyer_id, creator_id, "user", creator, attachment_path, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         RETURNING id`,
        [orderId, buyerId, row.creator_id, details || null, null, attachment_path, REQUEST_INITIAL_STATUS]
      );
      requestId = ins[0].id;

      // notify creator only on NEW
// notify creator only on NEW (de-duped)
if (!(await alreadyNotified(Number(row.creator_id), "creator_request", requestId))) {
  notify(
    Number(row.creator_id),
    "creator_request",
    "You’ve got a new custom request! 🎉",
    "Check out the details on your creator dashboard and let your creativity shine",
    { request_id: requestId }
  ).catch(console.error);

  notifyCreatorNewRequest({ requestId }).catch(console.error);
}
      return res.status(201).json({ ok: true, requestId });
    }
  } catch (e) {
    console.error("legacy POST /requests error:", e);
    return res.status(500).json({ ok: false, error: "Failed" });
  }
});

/**
 * CREATOR inbox: list requests for me (optionally filter by status)
 * Query: ?status=pending|accepted|declined|delivered
 *
 * CHANGES:
 *  - Removed buyer_email from SELECT (privacy)
 *  - Added p.title AS product_title so UI can display the product’s title
 */
router.get("/inbox", requireAuth, requireCreator, async (req, res) => {
  const creatorId = req.user.id;
  const { status } = req.query;

  try {
    // (Optional) existence check
    await db.query(`SELECT 1 FROM custom_requests WHERE creator_id=$1 LIMIT 1`, [creatorId]);

    const params = [creatorId];
    let where = `cr.creator_id = $1`;
    if (status) {
      const s = String(status).toLowerCase();
      if (s === "pending") {
        params.push("pending");
        where += ` AND (cr.status = $2 OR cr.status = 'open')`;
      } else {
        params.push(s);
        where += ` AND cr.status = $2`;
      }
    }

    const { rows } = await db.query(
      `SELECT cr.*,
              o.status AS order_status,
              p.price AS amount,
              p.title AS product_title,
              u.username AS buyer_username
         FROM custom_requests cr
         JOIN orders   o ON o.id = cr.order_id
         JOIN products p ON p.id = o.product_id
         JOIN users    u ON u.id = cr.buyer_id
        WHERE ${where}
        ORDER BY cr.created_at DESC`,
      params
    );

    res.json({ requests: rows.map(normalizeStatus) });
  } catch (err) {
    console.error("Inbox error:", err);
    res.status(500).json({ error: "Failed to fetch requests" });
  }
});

/**
 * BUYER view: list my requests
 */
router.get("/mine", requireAuth, async (req, res) => {
  const buyerId = req.user.id;
  try {
    const { rows } = await db.query(
      `SELECT cr.*, o.status AS order_status, o.amount_cents
         FROM custom_requests cr
         JOIN orders o ON o.id = cr.order_id
        WHERE cr.buyer_id = $1
        ORDER BY cr.created_at DESC`,
      [buyerId]
    );
    res.json({ requests: rows.map(normalizeStatus) });
  } catch (err) {
    console.error("My requests error:", err);
    res.status(500).json({ error: "Failed to fetch my requests" });
  }
});

/**
 * CREATOR accepts or declines a request
 * Body: { action: "accept" | "decline" }
 */
router.patch(
  "/:id/decision",
  requireAuth,
  requireCreator,
  standardLimiter,
  validate(requestDecision),
  async (req, res) => {
    const creatorId = req.user.id;
    const requestId = parseInt(req.params.id, 10);
    const { action } = req.body;

    try {
      // must be this creator's request
      const { rows } = await db.query(
        `SELECT id, status FROM custom_requests WHERE id=$1 AND creator_id=$2`,
        [requestId, creatorId]
      );
      const r = rows[0];
      if (!r) return res.status(404).json({ error: "Request not found" });
      // allow legacy 'open' to be treated as pending
      if (!(r.status === "pending" || r.status === "open"))
        return res.status(400).json({ error: "Request is not pending" });

      const newStatus = action === "accept" ? "accepted" : "declined";
      const { rows: upd } = await db.query(
        `UPDATE custom_requests SET status=$1 WHERE id=$2 RETURNING *`,
        [newStatus, requestId]
      );

      res.json({ success: true, request: normalizeStatus(upd[0]) });
    } catch (err) {
      console.error("Decision error:", err);
      res.status(500).json({ error: "Failed to update request" });
    }
  }
);

/**
 * CREATOR delivers a file (only after payment)
 * File field: "file"
 * - checks order is paid
 * - sets custom_requests.status='delivered' and stores attachment_path
 */
router.post(
  "/:id/deliver",
  requireAuth,
  requireCreator,
  standardLimiter,
  uploadCreator.single("file"),
  validate(requestDeliver),
  async (req, res) => {
    const creatorId = req.user.id;
    const requestId = parseInt(req.params.id, 10);

    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    try {
      // find the request and its order; include buyer_id for notification
      const { rows } = await db.query(
        `SELECT cr.id, cr.creator_id, cr.status, cr.order_id, cr.buyer_id,
                o.status AS order_status
           FROM custom_requests cr
           JOIN orders o ON o.id = cr.order_id
          WHERE cr.id = $1 AND cr.creator_id = $2`,
        [requestId, creatorId]
      );
      const r = rows[0];
      if (!r) return res.status(404).json({ error: "Request not found" });

      // only allow delivery after payment
      if (r.order_status !== "paid") {
        return res.status(400).json({ error: "Order is not paid yet" });
      }

        let deliveredFile = path.basename(req.file.path); // default: original upload

        // If it's not already mp4 (e.g. .mov) and needs transcoding, convert to mp4
        if (needsTranscode(req.file.mimetype, path.extname(req.file.originalname))) {
          const base = path.parse(deliveredFile).name;                 // filename without extension
          const mp4Name = `${base}.mp4`;
          const inPath = req.file.path;                                // /public/uploads/requests/<rand>.<ext>
          const outPath = path.join(uploadDirRequests, mp4Name);       // /public/uploads/requests/<rand>.mp4

          await transcodeToMp4(inPath, outPath);
          try { fs.unlinkSync(inPath); } catch {}                      // remove the original source after success
          deliveredFile = mp4Name;
        }

const webPath = `/uploads/requests/${deliveredFile}`;
const { rows: upd } = await db.query(
  `UPDATE custom_requests
      SET creator_attachment_path = $1,
          status = 'delivered'
    WHERE id = $2
    RETURNING *`,
  [webPath, requestId]
);

      res.json({ success: true, request: normalizeStatus(upd[0]) });

        // Only notify/email the first time we transition into delivered
        if (r.status !== "delivered") {
          // in-app (deduped)
          if (!(await alreadyNotified(Number(r.buyer_id), "request_ready", requestId))) {
            notify(
              Number(r.buyer_id),
              "request_ready",
              "Your request is ready! 🎉",
              "Check it out on your My Purchases page!",
              { request_id: requestId }
            ).catch(console.error);
          }

          // Email once (same condition)
          notifyRequestDelivered({ requestId }).catch(console.error);
        }
    
      } catch (err) {
      console.error("Deliver error:", err);
      res.status(500).json({ error: "Failed to deliver file" });
    }
  }
);

/**
 * CREATOR marks a request as fully complete (finalizes after delivery or acceptance)
 * Optional file field: "media" (if wanting to attach/replace a final file)
 * Body (multipart/form-data or JSON): { message | description }
 * - Sets custom_requests.status='complete'
 * - Sets custom_requests.creator to provided message (if any)
 * - Optionally updates creator_attachment_path if a file uploaded
 * - Sets related orders.status='complete'
 */
router.post(
  "/:id/complete",
  requireAuth,
  requireCreator,
  standardLimiter,
  uploadCreator.single("media"),
  async (req, res) => {
    const creatorId = req.user.id;
    const requestId = parseInt(req.params.id, 10);
    const creatorMessage = (req.body.message || req.body.description || "").toString().trim() || null;

    try {
      // Fetch request with its order; include buyer_id for notification
      const { rows } = await db.query(
        `SELECT cr.id, cr.creator_id, cr.status, cr.order_id, cr.attachment_path, cr.buyer_id,
                o.status AS order_status
           FROM custom_requests cr
           JOIN orders o ON o.id = cr.order_id
          WHERE cr.id = $1 AND cr.creator_id = $2
          LIMIT 1`,
        [requestId, creatorId]
      );
      const r = rows[0];
      if (!r) return res.status(404).json({ error: "Request not found" });
      if (r.status === "complete") return res.status(400).json({ error: "Request already complete" });
      if (r.status === "declined") return res.status(400).json({ error: "Declined request cannot be completed" });

      // For safety require order to be paid
      if (r.order_status !== "paid") {
        return res.status(400).json({ error: "Order is not paid yet" });
      }

      let newAttachment = null;
          if (req.file) {
            let fname = path.basename(req.file.path);
            if (needsTranscode(req.file.mimetype, path.extname(req.file.originalname))) {
              const base = path.parse(fname).name;
              const mp4Name = `${base}.mp4`;
              await transcodeToMp4(req.file.path, path.join(uploadDirRequests, mp4Name));
              try { fs.unlinkSync(req.file.path); } catch {}
              fname = mp4Name;
            }
            newAttachment = `/uploads/requests/${fname}`;
          }

      let updatedRow;
      try {
        await db.query("BEGIN");

        let updatedRowResult;
        try {
          const { rows: upd } = await db.query(
            `UPDATE custom_requests
                SET creator = COALESCE($1, creator),
                    creator_attachment_path = COALESCE($2, creator_attachment_path),
                    status = 'complete'
              WHERE id = $3
              RETURNING *`,
            [creatorMessage, newAttachment, requestId]
          );
          updatedRowResult = upd[0];
        } catch (crErr) {
          if (crErr && crErr.code === "23514") {
            // custom_requests constraint doesn't yet allow 'complete'
            await db.query("ROLLBACK");
            return res.status(409).json({
              error:
                "Database schema does not allow custom_requests.status='complete' (custom_requests_status_check)",
              hint:
                "Run migration to add 'complete' to custom_requests_status_check and retry",
              migration_example:
                "ALTER TABLE custom_requests DROP CONSTRAINT custom_requests_status_check; " +
                "ALTER TABLE custom_requests ADD CONSTRAINT custom_requests_status_check " +
                "CHECK (status IN ('open','pending','accepted','declined','delivered','complete'));",
            });
          }
          throw crErr;
        }
        updatedRow = updatedRowResult;

        // Attempt to mark the related order as complete (may need a similar enum/check migration)
        await db.query(
          `UPDATE orders
              SET status = 'complete'
            WHERE id = $1`,
          [r.order_id]
        );

        await db.query("COMMIT");
      } catch (err) {
        try {
          await db.query("ROLLBACK");
        } catch {}
        throw err;
      }

      const responseRow = {
        ...normalizeStatus(updatedRow),
        status: "complete",
        _stored_status: updatedRow.status,
        _order_status: "complete",
      };
      res.json({ success: true, request: responseRow });

      // in-app notification to buyer on completion as well
              if (r.status !== "delivered") {
          notify(
            Number(r.buyer_id),
            "request_ready",
            "Your request is ready! 🎉",
            "Check it out on your My Purchases page!",
            { request_id: requestId }
          ).catch(console.error);

          // Email too (same condition)
          notifyRequestDelivered({ requestId }).catch(console.error);
        }
      } catch (err) {
      try {
        await db.query("ROLLBACK");
      } catch {}
      console.error("Complete request error:", err);
      return res.status(500).json({ error: "Failed to complete request" });
    }
  }
);

/**
 * BUYER downloads the delivered file
 * - only buyer can download
 * - only when status='delivered'
 * Note: purchases download is in routes/downloads.js
 */
router.get("/:id/download", requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  const userId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT attachment_path, creator_attachment_path, status, buyer_id
         FROM custom_requests
        WHERE id = $1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });
    if (r.buyer_id !== userId) return res.status(403).json({ error: "Not your request" });
    if (r.status !== "delivered") return res.status(403).json({ error: "Not delivered yet" });
    const mediaPath = r.creator_attachment_path || r.attachment_path;
    if (!mediaPath) return res.status(404).json({ error: "No delivery file" });

    // Resolve absolute filesystem path
    let fullPath;
    if (mediaPath.startsWith("/uploads/")) {
      const relative = mediaPath.replace(/^\/+/, ""); // strip leading slash
      fullPath = path.join(__dirname, "..", "public", relative);
    } else {
      // legacy: stored as basename under uploads root
      fullPath = path.join(uploadDir, mediaPath);
    }
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "File missing on disk" });

    return res.download(fullPath, path.basename(mediaPath));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Download failed" });
  }
});

/* -------------------------- NEW: create-from-session -------------------------- */
/**
 * POST /api/requests/create-from-session
 * Body (multipart/form-data): { session_id: string, message?: string, attachment?: file('attachment') }
 * - Finds the PAID order for the current buyer by stripe_checkout_session_id
 * - Ensures the product is a 'request'
 * - Upserts a row in custom_requests linked to that order
 */
router.post(
  "/create-from-session",
  requireAuth,
  strictLimiter,
  upload.single("attachment"),
  async (req, res) => {
    try {
      const buyerId = req.user.id;
      const sessionId = String(req.body.session_id || "").trim();
      const message = (req.body.message || "").toString();
      if (!sessionId) return res.status(400).json({ error: "session_id is required" });

      // Find the buyer's PAID order by session id
      const { rows } = await db.query(
        `SELECT o.id AS order_id,
                o.buyer_id,
                o.product_id,
                o.status AS order_status,
                p.user_id AS creator_id,
                p.product_type,
                p.title
           FROM orders o
           JOIN products p ON p.id = o.product_id
          WHERE o.buyer_id = $1
            AND o.stripe_checkout_session_id = $2
          LIMIT 1`,
        [buyerId, sessionId]
      );

      const row = rows[0];
      if (!row) return res.status(404).json({ error: "Order not found for this session" });
      if (row.order_status !== "paid") return res.status(400).json({ error: "Order is not paid yet" });
      if (row.product_type !== "request") return res.status(400).json({ error: "Not a request-type product" });

      const attachment_path = req.file ? `/uploads/${path.basename(req.file.path)}` : null;

      // Upsert custom_request for (order_id, buyer_id)
      const existing = await db.query(
        `SELECT id FROM custom_requests WHERE order_id=$1 AND buyer_id=$2`,
        [row.order_id, buyerId]
      );

      let request;
      if (existing.rows.length) {
        const { rows: upd } = await db.query(
          `UPDATE custom_requests
              SET "user" = COALESCE($2, "user"),
                  attachment_path = COALESCE($3, attachment_path)
            WHERE id = $1
          RETURNING *`,
          [existing.rows[0].id, message || null, attachment_path]
        );
        request = upd[0];
      } else {
        const { rows: ins } = await db.query(
          `INSERT INTO custom_requests (order_id, buyer_id, creator_id, "user", creator, attachment_path, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           RETURNING *`,
          [row.order_id, buyerId, row.creator_id, message || null, null, attachment_path, REQUEST_INITIAL_STATUS]
        );
        request = ins[0];

        // notify creator only on NEW (de-duped)
        if (!(await alreadyNotified(Number(row.creator_id), "creator_request", request.id))) {
          await Promise.allSettled([
            notify(
              Number(row.creator_id),
              "creator_request",
              "You’ve got a new custom request! 🎉",
              "Check out the details on your creator dashboard and let your creativity shine",
              { request_id: request.id }
            ),
            // Email only (see section C); ok to keep here
            notifyCreatorNewRequest({ requestId: request.id }),
          ]);
        }
      }

      return res.status(201).json({ success: true, request: normalizeStatus(request) });
    } catch (e) {
      console.error("create-from-session error:", e);
      return res.status(500).json({ error: "Failed to create request" });
    }
  }
);

module.exports = router;