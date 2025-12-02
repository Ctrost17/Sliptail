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
const storage = require("../storage");
const { buildDisposition } = require("../utils/disposition");
const { makeAndStorePoster } = require("../utils/videoPoster");
const os = require("os");
const mime = require("mime-types");

const Stripe = require("stripe");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { sendEmail } = require("../emails/mailer");
const T = require("../emails/templates");

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("Stripe not configured: missing STRIPE_SECRET_KEY");
  }
  return Stripe(key);
}

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

const allowed = new Set([
  "application/pdf",
  "application/epub+zip",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg",
  "image/svg+xml",
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "text/plain",
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "audio/mpeg",
  "audio/mp3",
  "audio/aac",
  "audio/m4a",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
]);

// Use disk storage to avoid buffering GB files in RAM.
// We’ll pass req.file.path to storage.uploadPrivate so it can stream/multipart to S3.
const tmpDisk = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `req-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const baseMulter = {
  storage: tmpDisk,
  // Keep your generous cap, or tighten it if you want to save bandwidth/S3 PUT$:
  limits: { fileSize: 2500 * 1024 * 1024 }, // 2.5GB
  fileFilter: (req, file, cb) => {
    if (!allowed.has(file.mimetype)) return cb(new Error("Unsupported file type"));
    cb(null, true);
  },
};

// Buyers attach to request (private)
const upload = multer(baseMulter);

// Creator delivers/complete (also private)
const uploadCreator = multer(baseMulter);

// small helper to make S3 keys
function newKey(prefix, original) {
  const id =
    (crypto.randomUUID && crypto.randomUUID()) ||
    crypto.randomBytes(16).toString("hex");
  const ext = path.extname(original || "");
  return `${prefix}/${id}${ext}`;
}
function posterKeyFor(videoKey) {
  // same folder, just replace extension with .jpg
  return String(videoKey || "").replace(/\.[^./\\]+$/, "") + ".jpg";
}

function looksVideoContentType(ct) {
  return typeof ct === "string" && ct.toLowerCase().startsWith("video/");
}
function looksVideoKey(key) {
  const ext = String(key || "").toLowerCase().split(".").pop() || "";
  return ["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(ext);
}

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

async function getStripeAccountIdForUser(userId) {
  const uid = String(userId);

  try {
    const { rows } = await db.query(
      `SELECT account_id FROM stripe_connect WHERE user_id = $1 LIMIT 1`,
      [uid]
    );

    if (rows.length && rows[0].account_id) {
      return rows[0].account_id;   // <-- Correct column that exists in your DB
    }
  } catch (e) {
    console.error("Stripe account lookup failed:", e?.message || e);
  }

  return null;
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

    // Prefer presigned flow: client already PUT to S3 and sends us the key
    let attachment_path = null;
    const presignedKey = (req.body.attachment_key || "").trim();

    if (presignedKey) {
      attachment_path = presignedKey;
      // best-effort poster (video only)
      const ct = String(req.body.attachment_content_type || "").toLowerCase();
      if (looksVideoContentType(ct) || (!ct && looksVideoKey(attachment_path))) {
        try { await makeAndStorePoster(attachment_path, { private: true }); }
        catch (e) { console.warn("buyer attachment poster (create presigned) skipped:", e?.message || e); }
      }
    } else if (req.file) {
      // fallback: old multipart path
      const key = newKey("requests", req.file.originalname);
      const uploaded = await storage.uploadPrivate({
        key,
        contentType: req.file.mimetype || "application/octet-stream",
        contentDisposition: buildDisposition("attachment", req.file.originalname),
        body: req.file.path || req.file.buffer,
      });
      if (req.file.path) { try { await fs.promises.unlink(req.file.path); } catch {} }
      attachment_path = uploaded.key;
        const ct = String(req.file.mimetype || "").toLowerCase();
        if (looksVideoContentType(ct) || (!ct && looksVideoKey(attachment_path))) {
          try { await makeAndStorePoster(attachment_path, { private: true }); }
          catch (e) { console.warn("buyer attachment poster (create) skipped:", e?.message || e); }
        }
    }
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

      let attachment_path = null;

      const presignedKey = (req.body.attachment_key || "").trim();
      if (presignedKey) {
        attachment_path = presignedKey;
        const ct = String(req.body.attachment_content_type || "").toLowerCase();
        if (looksVideoContentType(ct) || (!ct && looksVideoKey(attachment_path))) {
          try { await makeAndStorePoster(attachment_path, { private: true }); }
          catch (e) { console.warn("buyer attachment poster (legacy presigned) skipped:", e?.message || e); }
        }
      } else if (req.file) {
        const key = newKey("requests", req.file.originalname);
        const uploaded = await storage.uploadPrivate({
          key,
          contentType: req.file.mimetype || "application/octet-stream",
          contentDisposition: buildDisposition("attachment", req.file.originalname),
          body: req.file.path || req.file.buffer,
        });
        if (req.file.path) { try { await fs.promises.unlink(req.file.path); } catch {} }
        attachment_path = uploaded.key;
        const ct = String(req.file.mimetype || "").toLowerCase();
        if (looksVideoContentType(ct) || (!ct && looksVideoKey(attachment_path))) {
          try { await makeAndStorePoster(attachment_path, { private: true }); }
          catch (e) { console.warn("buyer attachment poster (legacy) skipped:", e?.message || e); }
        }
      }

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
      `SELECT
         cr.*,
         o.status       AS order_status,
         o.amount_cents,
         /* ✅ Has this buyer already left a review? (product-level OR creator-level) */
         EXISTS (
           SELECT 1
             FROM reviews r
            WHERE r.buyer_id = $1
              AND (
                    r.product_id = o.product_id
                 OR (
                      r.product_id IS NULL
                  AND r.creator_id = p.user_id
                    )
                  )
            LIMIT 1
         ) AS user_has_review
       FROM custom_requests cr
       JOIN orders   o ON o.id = cr.order_id
       JOIN products p ON p.id = o.product_id
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
 *
 * If declined:
 *  - Refunds the buyer for (amount_cents - Stripe processing fee) in production
 *  - Also reverses the 4 percent application fee
 *  - Does NOT refund the Stripe merchant processing fee
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
    const { action } = req.body; // "accept" or "decline"

    if (action !== "accept" && action !== "decline") {
      return res.status(400).json({ error: "Invalid action" });
    }

    try {
      await db.query("BEGIN");

      // 1) Lock ONLY the custom_requests row (no joins)
      const { rows: crRows } = await db.query(
        `
        SELECT id, status, order_id
          FROM custom_requests
         WHERE id = $1
           AND creator_id = $2
         FOR UPDATE
        `,
        [requestId, creatorId]
      );

      const cr = crRows[0];
      if (!cr) {
        await db.query("ROLLBACK");
        return res.status(404).json({ error: "Request not found" });
      }

      // Treat legacy "open" as "pending"
      const currentStatus = cr.status === "open" ? "pending" : cr.status;
      if (currentStatus !== "pending") {
        await db.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "Request is not pending and cannot be changed" });
      }

      // 2) Load order row separately
      let order = null;
      if (cr.order_id) {
        const { rows: orderRows } = await db.query(
          `
          SELECT
            status                AS order_status,
            stripe_payment_intent_id,
            amount_cents
          FROM orders
          WHERE id = $1
          `,
          [cr.order_id]
        );
        order = orderRows[0] || null;
      }

      const newStatus = action === "accept" ? "accepted" : "declined";

      // Track whether we actually processed a refund
      let didRefund = false;

      console.log("[REQUEST DECISION DEBUG]", {
        requestId,
        action,
        orderId: cr.order_id,
        orderStatus: order ? order.order_status : null,
        stripePaymentIntentId: order ? order.stripe_payment_intent_id : null,
        amountCents: order ? order.amount_cents : null,
        nodeEnv: process.env.NODE_ENV,
      });

      // If creator is declining, attempt a partial refund (keep Stripe fee, refund rest)
      if (action === "decline" && order && cr.order_id) {
        const isFree =
          !order.amount_cents || Number(order.amount_cents) <= 0;
        const hasPaymentIntent = !!order.stripe_payment_intent_id;

        // For free or non Stripe backed orders, skip Stripe refunds entirely
        if (isFree || !hasPaymentIntent) {
          console.log(
            "[REQUEST DECISION] Decline for free or non Stripe order, skipping Stripe refund",
            {
              requestId,
              orderId: cr.order_id,
              amountCents: order.amount_cents,
              stripePaymentIntentId: order.stripe_payment_intent_id,
            }
          );
        } else if (process.env.NODE_ENV === "production") {
          try {
            const stripe = getStripe();

            // Look up creator connected account (the payment lives here)
            const stripeAccountId = await getStripeAccountIdForUser(creatorId);
            if (!stripeAccountId) {
              throw new Error(
                `No connected Stripe account found for creator ${creatorId}`
              );
            }

            const stripeOpts = { stripeAccount: stripeAccountId };

            // Retrieve the PI on the connected account and expand charges
            const pi = await stripe.paymentIntents.retrieve(
              order.stripe_payment_intent_id,
              {
                expand: [
                  "latest_charge.balance_transaction",
                  "charges.data.balance_transaction",
                ],
              },
              stripeOpts
            );

            // Try latest_charge first, then fall back to charges.data[0]
            let charge = null;
            if (pi.latest_charge && typeof pi.latest_charge === "object") {
              charge = pi.latest_charge;
            } else if (
              pi.charges &&
              Array.isArray(pi.charges.data) &&
              pi.charges.data.length > 0
            ) {
              charge = pi.charges.data[0];
            }

            if (!charge) {
              throw new Error(
                "No charge found on PaymentIntent for partial refund"
              );
            }

            const totalAmount =
              typeof charge.amount === "number"
                ? charge.amount
                : Number(order.amount_cents || 0);

            const alreadyRefunded = charge.amount_refunded || 0;

            // If it's already fully refunded, just mark it and move on
            if (alreadyRefunded >= totalAmount) {
              console.log(
                "[PARTIAL REFUND] PaymentIntent already fully refunded, just marking DB"
              );
              await db.query(
                `UPDATE orders SET status = 'refunded' WHERE id = $1`,
                [cr.order_id]
              );
              didRefund = true;
            } else {
              // 1) Get Stripe fees from the balance transaction if possible
              let feeCents = 0;
              let bt = charge.balance_transaction;

              if (bt && typeof bt === "object" && bt.fee != null) {
                feeCents = bt.fee;
              } else if (bt && typeof bt === "string") {
                const fullBt = await stripe.balanceTransactions.retrieve(
                  bt,
                  stripeOpts
                );
                feeCents = fullBt.fee || 0;
              }

              // 2) Compute desired refund = total - Stripe fee
              let desiredRefund;
              if (feeCents > 0 && feeCents < totalAmount) {
                desiredRefund = totalAmount - feeCents;
              } else {
                // Fallback estimate if we could not read fee from Stripe
                const estimatedFee = Math.round(totalAmount * 0.03) + 30; // approx 3 percent + 30 cents
                desiredRefund = Math.max(totalAmount - estimatedFee, 0);
              }

              const maxRefundable = totalAmount - alreadyRefunded;
              const refundAmountCents = Math.max(
                Math.min(desiredRefund, maxRefundable),
                0
              );

              console.log("[PARTIAL REFUND DEBUG]", {
                totalAmount,
                alreadyRefunded,
                feeCents,
                desiredRefund,
                maxRefundable,
                refundAmountCents,
              });

              if (refundAmountCents > 0) {
                await stripe.refunds.create(
                  {
                    payment_intent: order.stripe_payment_intent_id,
                    amount: refundAmountCents,
                    // Reverse your 4 percent application fee on the platform
                    refund_application_fee: true,
                  },
                  stripeOpts
                );

                await db.query(
                  `UPDATE orders SET status = 'refunded' WHERE id = $1`,
                  [cr.order_id]
                );
                didRefund = true;
              } else {
                console.warn(
                  "[PARTIAL REFUND] Computed refundAmountCents=0; skipping Stripe refund"
                );
              }
            }
          } catch (e) {
            console.error("Failed to process partial refund for request:", e);
            await db.query("ROLLBACK");
            return res.status(500).json({
              error: "Failed to process refund, please try again.",
            });
          }
        } else {
          // Local or staging: simulate refund without hitting Stripe
          console.log(
            "[DEV] Skipping real Stripe refund for request decline; marking order as refunded in DB only."
          );
          await db.query(
            `UPDATE orders SET status = 'refunded' WHERE id = $1`,
            [cr.order_id]
          );
          didRefund = true;
        }
      }

      // 3) Update the request status
      const { rows: upd } = await db.query(
        `UPDATE custom_requests
            SET status = $1
          WHERE id = $2
        RETURNING *`,
        [newStatus, requestId]
      );

      await db.query("COMMIT");

      // 4) If we actually refunded, send refund email to the buyer
      if (action === "decline" && didRefund) {
        (async () => {
          try {
            const { rows: emailRows } = await db.query(
              `SELECT u.email AS buyer_email,
                      p.title AS product_title
                 FROM custom_requests cr
                 JOIN orders   o ON o.id = cr.order_id
                 JOIN products p ON p.id = o.product_id
                 JOIN users    u ON u.id = cr.buyer_id
                WHERE cr.id = $1
                LIMIT 1`,
              [requestId]
            );

            if (!emailRows.length) return;
            const { buyer_email, product_title } = emailRows[0];
            if (!buyer_email) return;

            const msg = T.userRequestRefunded({ productTitle: product_title });

            await sendEmail({
              to: buyer_email,
              subject: msg.subject,
              text: msg.text,
              html: msg.html,
            });
          } catch (e) {
            console.warn(
              "Failed to send refund email for declined request:",
              e?.message || e
            );
          }
        })();
      }

      return res.json({
        success: true,
        request: normalizeStatus(upd[0]),
      });
    } catch (err) {
      console.error("request decision error:", err);
      try {
        await db.query("ROLLBACK");
      } catch (_) {}
      return res.status(500).json({ error: "Failed to update request" });
    }
  }
);

/**
 * CREATOR delivers a file (only after payment)
 * File field: "file"
 * - checks order is paid
 * - sets custom_requests.status='delivered' and stores attachment_path
 */
router.post("/:id/deliver", requireAuth, requireCreator, standardLimiter, uploadCreator.single("file"), validate(requestDeliver), async (req, res) => {
  const creatorId = req.user.id;
  const requestId = parseInt(req.params.id, 10);

  // --- fetch request & order first (shared) ---
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
  if (r.order_status !== "paid") return res.status(400).json({ error: "Order is not paid yet" });

      // ---- presigned shortcut ----
    let creatorKey = (req.body.creator_attachment_key || "").trim();
    if (creatorKey) {
      try {
        const ct = String(req.body.content_type || "").toLowerCase();

        // If missing extension, append one from content-type (video focus)
        if (!/\.[a-z0-9]+$/i.test(creatorKey)) {
          if (ct === "video/quicktime") creatorKey += ".mov";
          else if (ct === "video/webm") creatorKey += ".webm";
          else if (ct.startsWith("video/")) creatorKey += ".mp4";
          // you can add audio/image mappings here if needed
        }

    if (looksVideoContentType(ct) || (!ct && looksVideoKey(creatorKey))) {
      try { await makeAndStorePoster(creatorKey, { private: true }); }
      catch (e) { console.warn("poster (presigned) skipped:", e?.message || e); }
    }

    await db.query("BEGIN");
    const { rows: updated } = await db.query(
      `UPDATE custom_requests
          SET creator_attachment_path = $1,
              status = 'complete'
        WHERE id = $2
        RETURNING *`,
      [creatorKey, requestId]
    );
      await db.query(`UPDATE orders SET status = 'complete' WHERE id = $1`, [r.order_id]);
      await db.query("COMMIT");

      res.json({ success: true, request: normalizeStatus(updated[0]) });

      if (!(await alreadyNotified(Number(r.buyer_id), "request_ready", requestId))) {
        notify(Number(r.buyer_id), "request_ready", "Your request is ready! 🎉", "Check it out on your My Purchases page!", { request_id: requestId }).catch(console.error);
        notifyRequestDelivered({ requestId }).catch(console.error);
      }
      return;
    } catch (err) {
      try { await db.query("ROLLBACK"); } catch {}
      console.error("Deliver (presigned) error:", err);
      return res.status(500).json({ error: "Failed to deliver file" });
    }
  }

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

      const mime = req.file?.mimetype || "";
      const isAudio = mime.startsWith("audio/");
      let key;

      if (!isAudio && needsTranscode(mime, path.extname(req.file.originalname))) {
        // If multer wrote a tmp file, use it directly as input; else write buffer to tmp
        const inTmp = req.file.path || path.join(os.tmpdir(), `in-${crypto.randomBytes(8).toString("hex")}${path.extname(req.file.originalname)}`);
        if (!req.file.path) fs.writeFileSync(inTmp, req.file.buffer);

        const outTmp = path.join(os.tmpdir(), `out-${crypto.randomBytes(8).toString("hex")}.mp4`);
        await transcodeToMp4(inTmp, outTmp);

        const baseKey = newKey("requests", req.file.originalname).replace(/\.[^./\\]+$/, "");
        key = `${baseKey}.mp4`;

        // Upload by PATH so storage.js can multipart/stream
        await storage.uploadPrivate({ key, contentType: "video/mp4", body: outTmp });

        try {
          await makeAndStorePoster(key, { private: true });
        } catch (e) {
          console.warn("request deliver: poster generation failed:", e?.message || e);
        }

        try { fs.unlinkSync(inTmp); } catch {}
        try { fs.unlinkSync(outTmp); } catch {}
      } else {
        key = newKey("requests", req.file.originalname);
      await storage.uploadPrivate({
        key,
        contentType: mime || "application/octet-stream",
        body: req.file.path || req.file.buffer,
      });
      if (req.file.path) { try { await fs.promises.unlink(req.file.path); } catch {} }
      }
        if (looksVideoContentType(mime) || (!mime && looksVideoKey(key))) {
          try { await makeAndStorePoster(key, { private: true }); }
          catch (e) { console.warn("request deliver: poster skipped:", e?.message || e); }
        }     

      // ⬇️ Persist delivery and mark COMPLETE (single terminal state)
      await db.query("BEGIN");
      const { rows: updated } = await db.query(
        `UPDATE custom_requests
            SET creator_attachment_path = $1,
                status = 'complete'
          WHERE id = $2
          RETURNING *`,
        [key, requestId]
      );
      await db.query(
        `UPDATE orders SET status = 'complete' WHERE id = $1`,
        [r.order_id]
      );
      await db.query("COMMIT");

      res.json({ success: true, request: normalizeStatus(updated[0]) });

      // Notify buyer (deduped)
      if (!(await alreadyNotified(Number(r.buyer_id), "request_ready", requestId))) {
        notify(
          Number(r.buyer_id),
          "request_ready",
          "Your request is ready! 🎉",
          "Check it out on your My Purchases page!",
          { request_id: requestId }
        ).catch(console.error);
        notifyRequestDelivered({ requestId }).catch(console.error);
      }
    } catch (err) {
      try { await db.query("ROLLBACK"); } catch {}
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

          // --- Presigned replace/attach on complete (no server relay) ---
          const presignedKey = (req.body.attachment_key || "").trim();
          let newAttachment = null;

          if (presignedKey) {
            let k = presignedKey;
            const ct = String(req.body.content_type || "").toLowerCase();

            if (!/\.[a-z0-9]+$/i.test(k)) {
              if (ct === "video/quicktime") k += ".mov";
              else if (ct === "video/webm") k += ".webm";
              else if (ct.startsWith("video/")) k += ".mp4";
            }

            newAttachment = k;

            if (looksVideoContentType(ct) || (!ct && looksVideoKey(newAttachment))) {
              try { await makeAndStorePoster(newAttachment, { private: true }); }
              catch (e) { console.warn("request complete: poster (presigned) skipped:", e?.message || e); }
            }
          }
          // --- end presigned block ---

          if (!newAttachment && req.file) {
          const mime = req.file?.mimetype || "";
          const isAudio = mime.startsWith("audio/");

          if (!isAudio && needsTranscode(mime, path.extname(req.file.originalname))) {
            const inTmp = req.file.path || path.join(os.tmpdir(), `in-${crypto.randomBytes(8).toString("hex")}${path.extname(req.file.originalname)}`);
            if (!req.file.path) fs.writeFileSync(inTmp, req.file.buffer);

            const outTmp = path.join(os.tmpdir(), `out-${crypto.randomBytes(8).toString("hex")}.mp4`);
            await transcodeToMp4(inTmp, outTmp);

            const baseKey = newKey("requests", req.file.originalname).replace(/\.[^./\\]+$/, "");
            const key = `${baseKey}.mp4`;

            await storage.uploadPrivate({
              key,
              contentType: "video/mp4",
              body: outTmp, // path, not buffer
            });

            newAttachment = key;
            try {
              await makeAndStorePoster(newAttachment, { private: true });
            } catch (e) {
              console.warn("request complete: poster generation failed:", e?.message || e);
            }            
            try { fs.unlinkSync(inTmp); } catch {}
            try { fs.unlinkSync(outTmp); } catch {}
          } else {
            const key = newKey("requests", req.file.originalname);
            await storage.uploadPrivate({
              key,
              contentType: mime || "application/octet-stream",
              body: req.file.path || req.file.buffer,
            });
            if (req.file.path) { try { await fs.promises.unlink(req.file.path); } catch {} }
            newAttachment = key;
            if (looksVideoContentType(mime) || (!mime && looksVideoKey(newAttachment))) {
              try { await makeAndStorePoster(newAttachment, { private: true }); }
              catch (e) { console.warn("request complete: poster skipped:", e?.message || e); }
            }
          }
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
 * CREATOR inline view of the BUYER's attachment (works for STORAGE_DRIVER=local|s3)
 * - only the creator assigned to this request can view
 * - streams with Content-Disposition:inline and supports Range for video/audio
 */
router.get("/:id/attachment", requireAuth, requireCreator, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  const creatorId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT creator_id, attachment_path
         FROM custom_requests
        WHERE id = $1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });
    if (Number(r.creator_id) !== Number(creatorId)) {
      return res.status(403).json({ error: "Not your request" });
    }
    const key = (r.attachment_path || "").trim();
    if (!key) return res.status(404).json({ error: "No buyer attachment" });

      const url = await storage.getPrivateUrl(key, { expiresIn: 300 });
      return res.redirect(302, url);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Attachment view failed" });
  }
});

// creator downloads buyer's attachment
router.get("/:id/attachment/file", requireAuth, requireCreator, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  const creatorId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT creator_id, attachment_path FROM custom_requests WHERE id=$1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });
    if (Number(r.creator_id) !== Number(creatorId)) return res.status(403).json({ error: "Not your request" });
    const key = (r.attachment_path || "").trim();
    if (!key) return res.status(404).json({ error: "No buyer attachment" });

    const filename = key.split("/").pop() || "attachment";
    const url = await storage.getSignedDownloadUrl(key, { filename, expiresSeconds: 60 });
    return res.redirect(302, url);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Attachment download failed" });
  }
});

// BUYER downloads creator’s file (no fallback)
// BUYER downloads creator’s file (only when complete)
router.get("/:id/download", requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  const userId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT creator_attachment_path, status, buyer_id FROM custom_requests WHERE id=$1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });
    if (Number(r.buyer_id) !== Number(userId)) return res.status(403).json({ error: "Not your request" });
    if (String(r.status || "").toLowerCase() !== "complete") return res.status(403).json({ error: "Not ready for download" });

    const key = storage.keyFromPublicUrl((r.creator_attachment_path || "").trim());
    if (!key) return res.status(404).json({ error: "No delivery file" });

    const filename = key.split("/").pop() || "delivery";
    const url = await storage.getSignedDownloadUrl(key, { filename, expiresSeconds: 60, disposition: "attachment" });
    return res.redirect(302, url);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Download failed" });
  }
});


// BUYER: download their own submitted attachment
router.get("/:id/my-attachment/file", requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  const buyerId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT buyer_id, attachment_path FROM custom_requests WHERE id=$1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });
    if (Number(r.buyer_id) !== Number(buyerId)) return res.status(403).json({ error: "Not your request" });

    const key = storage.keyFromPublicUrl((r.attachment_path || "").trim());
    if (!key) return res.status(404).json({ error: "No attachment uploaded" });

    const filename = key.split("/").pop() || "attachment";
    const url = await storage.getSignedDownloadUrl(key, { filename, expiresSeconds: 60, disposition: "attachment" });
    return res.redirect(302, url);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Attachment download failed" });
  }
});

// CREATOR: inline fetch of a poster/thumbnail for the BUYER's attachment (if available)
router.get("/:id/attachment/poster", requireAuth, requireCreator, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  const creatorId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT creator_id, attachment_path FROM custom_requests WHERE id = $1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });
    if (Number(r.creator_id) !== Number(creatorId)) {
      return res.status(403).json({ error: "Not your request" });
    }

    const key = (r.attachment_path || "").trim();
    if (!key) return res.status(404).json({ error: "No buyer attachment" });

    const posterKey = posterKeyFor(key);
    // Redirect to signed (CF) URL for the poster
    const url = await storage.getPrivateUrl(posterKey, { expiresIn: 300 });
    return res.redirect(302, url);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Attachment poster failed" });
  }
});

// BUYER: inline stream of creator’s delivery (only when complete)
router.get("/:id/delivery", requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  const buyerId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT buyer_id, status, creator_attachment_path
         FROM custom_requests
        WHERE id = $1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });
    if (Number(r.buyer_id) !== Number(buyerId))
      return res.status(403).json({ error: "Not your request" });

    const s = String(r.status || "").toLowerCase();
    if (s !== "complete")
      return res.status(403).json({ error: "Not ready yet" });

    const key = (r.creator_attachment_path || "").trim();
    if (!key) return res.status(404).json({ error: "No delivery file" });

    // Redirect to short-lived private URL (S3/CF)
    const url = await storage.getPrivateUrl(key, { expiresIn: 300 });
    return res.redirect(302, url);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Delivery view failed" });
  }
});

// BUYER: get delivery metadata (content-type) without following redirects
router.get("/:id/delivery/meta", requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  const buyerId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT buyer_id, status, creator_attachment_path
         FROM custom_requests
        WHERE id = $1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });
    if (Number(r.buyer_id) !== Number(buyerId)) {
      return res.status(403).json({ error: "Not your request" });
    }

    const s = String(r.status || "").toLowerCase();
    if (s !== "complete") return res.status(403).json({ error: "Not ready yet" });

    const key = (r.creator_attachment_path || "").trim();
    if (!key) return res.status(404).json({ error: "No delivery file" });

    // 1) ask storage for real content type (S3 HEAD)
    const head = await storage.headPrivate(key);
    // 2) fallback to filename if HEAD missing
    const fallback = mime.lookup(key) || "application/octet-stream";

    res.json({ contentType: (head && head.contentType) || fallback });
  } catch (e) {
    console.error("delivery/meta error:", e);
    res.status(500).json({ error: "Failed to load meta" });
  }
});

// BUYER: inline stream of creator’s delivery (status must be delivered|complete)
router.get("/:id/delivery/poster", requireAuth, async (req, res) => {
  const requestId = parseInt(req.params.id, 10);
  const buyerId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT buyer_id, status, creator_attachment_path
         FROM custom_requests
        WHERE id = $1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "Request not found" });
    if (Number(r.buyer_id) !== Number(buyerId))
      return res.status(403).json({ error: "Not your request" });

    const s = String(r.status || "").toLowerCase();
    if (s !== "complete")
      return res.status(403).json({ error: "Not ready yet" });

    const key = (r.creator_attachment_path || "").trim();
    if (!key) return res.status(404).json({ error: "No delivery file" });

    const posterKey = posterKeyFor(key);
    // Redirect to signed (CF) URL for the poster
    const url = await storage.getPrivateUrl(posterKey, { expiresIn: 300 });
    return res.redirect(302, url);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Poster view failed" });
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

        let attachment_path = null;
        const presignedKey = (req.body.attachment_key || "").trim();

        if (presignedKey) {
          attachment_path = presignedKey;
          const ct = String(req.body.attachment_content_type || "").toLowerCase();
          if (looksVideoContentType(ct) || (!ct && looksVideoKey(attachment_path))) {
            try { await makeAndStorePoster(attachment_path, { private: true }); }
            catch (e) { console.warn("buyer attachment poster (from-session presigned) skipped:", e?.message || e); }
          }
        } else if (req.file) {
          const key = newKey("requests", req.file.originalname);
          const uploaded = await storage.uploadPrivate({
            key,
            contentType: req.file.mimetype || "application/octet-stream",
            contentDisposition: buildDisposition("attachment", req.file.originalname),
            body: req.file.path || req.file.buffer,
          });
          if (req.file.path) { try { await fs.promises.unlink(req.file.path); } catch {} }
          attachment_path = uploaded.key;
          const ct = String(req.file.mimetype || "").toLowerCase();
          if (looksVideoContentType(ct) || (!ct && looksVideoKey(attachment_path))) {
            try { await makeAndStorePoster(attachment_path, { private: true }); }
            catch (e) { console.warn("buyer attachment poster (from-session) skipped:", e?.message || e); }
          }
        }

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