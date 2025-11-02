// routes/stripeCheckout.js
const express = require("express");
const Stripe = require("stripe");
const db = require("../db");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { checkoutSession } = require("../validators/schemas");
const { strictLimiter } = require("../middleware/rateLimit");

const router = express.Router();
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("Stripe not configured: missing STRIPE_SECRET_KEY");
  }
  return Stripe(key);
}

// 4% fee in basis points (default 400 bps)
const PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "400", 10);

// NOTE: products.price is integer **cents** in your DB. Do NOT multiply by 100 again.

// Success/cancel fallback URLs (frontend can override in body)
const FRONTEND = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");

// Helper that respects client-provided URLs and only appends the session if absent
function ensureSuccessUrl(rawUrl, fallbackPath = "/checkout/success") {
  const base = rawUrl || `${FRONTEND}${fallbackPath}`;
  if (base.includes("{CHECKOUT_SESSION_ID}")) return base; // client already provided a template
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}session_id={CHECKOUT_SESSION_ID}`;
}
function ensureCancelUrl(rawUrl, fallbackPath = "/checkout/cancel") {
  return rawUrl || `${FRONTEND}${fallbackPath}`;
}

/**
 * POST /api/stripe-checkout/create-session
 * body: { product_id: number, mode: "payment"|"subscription", success_url?, cancel_url? }
 */
router.post(
  "/create-session",
  requireAuth,
  strictLimiter,
  validate(checkoutSession),
  async (req, res) => {
    const buyerId = req.user.id;
    const {
      product_id,
      mode, // "payment" for purchase/request, "subscription" for membership
      success_url,
      cancel_url,
    } = req.body || {};

    // 1) Load product and creator’s connect account
    const { rows } = await db.query(
      `
      SELECT
        p.id,
        p.title,
        p.product_type,       -- e.g. 'download' | 'request' | 'membership' (adapt to your enum)
        p.price,              -- integer cents
        p.user_id AS creator_id,
        u.stripe_account_id
      FROM products p
      JOIN users u ON u.id = p.user_id
      WHERE p.id = $1
      `,
      [product_id]
    );
    const p = rows[0];
    if (!p) return res.status(404).json({ error: "Product not found" });

    if (!p.stripe_account_id) {
      return res.status(400).json({ error: "Creator has not completed Stripe onboarding" });
    }

    // Compute cents from DB value (already cents)
    const amountCents = Number(p.price);
      if (!Number.isFinite(amountCents)) {
        return res.status(400).json({ error: "Invalid price" });
      }

    const feeAmount = Math.floor((amountCents * PLATFORM_FEE_BPS) / 10000); // bps of price
// Canonicalize from the DB row ONLY (ignore client-provided mode for safety)
const productType = String(p.product_type || "").toLowerCase(); // 'purchase' | 'request' | 'membership'
const action =
  productType === "membership" ? "membership" :
  productType === "request"    ? "request"    :
  "purchase";

const finalMode = productType === "membership" ? "subscription" : "payment";
console.log("[checkout] product_type:", productType, "finalMode:", finalMode, "reqMode:", mode);

// Build success/cancel with acct & pid AFTER we know action
const baseSuccess = ensureSuccessUrl(success_url);
const sep = baseSuccess.includes("?") ? "&" : "?";
const successUrl = `${baseSuccess}${sep}acct=${encodeURIComponent(p.stripe_account_id)}&pid=${encodeURIComponent(p.id)}`;

const baseCancel = ensureCancelUrl(cancel_url);
const csep = baseCancel.includes("?") ? "&" : "?";
const cancelUrl = `${baseCancel}${csep}pid=${encodeURIComponent(p.id)}&action=${encodeURIComponent(action)}`;

// Common metadata we want to see again in webhooks/finalizer
const baseMetadata = {
  action,                         // "purchase" | "request" | "membership"
  product_id: String(p.id),
  product_type: String(p.product_type || ""),
  creator_id: String(p.creator_id),
  buyer_id: String(buyerId),
};

// Optional client-provided idempotency key
const clientKey = req.get("x-idempotency-key");

// ---- FREE FLOW (bypass Stripe entirely) ----
if (amountCents === 0) {
  // Synthetic session id so success page can still pass ?session_id=...
  const freeSessionId = `free_${p.id}_${Date.now()}`;

  if (finalMode === "payment") {
    // FREE one-time product (purchase or request): insert a PAID order with amount 0
    let finalOrderId = null;
    try {
      const { rows: ins } = await db.query(
        `
        INSERT INTO public.orders
          (buyer_id, product_id, amount_cents, stripe_payment_intent_id, status, created_at, stripe_checkout_session_id)
        VALUES ($1,$2,$3,NULL,'paid',NOW(),$4)
        RETURNING id
        `,
        [buyerId, p.id, 0, freeSessionId]
      );
      finalOrderId = ins[0]?.id ?? null;
    } catch (e) {
      // If a race wrote it already, fetch it
      const { rows: existing } = await db.query(
        `SELECT id FROM public.orders WHERE stripe_checkout_session_id=$1 LIMIT 1`,
        [freeSessionId]
      );
      finalOrderId = existing[0]?.id ?? null;
    }

    // Optional: notify creator for free *request* the same way you do for paid sales
    // (uncomment if you want in-app notification)
    /*
    try {
      const { rows: info } = await db.query(
        `SELECT o.id AS order_id, p.id AS product_id, p.title AS product_title, p.user_id AS creator_id, p.product_type
           FROM orders o
           JOIN products p ON p.id = o.product_id
          WHERE o.id = $1
          LIMIT 1`,
        [finalOrderId]
      );
      const row = info[0];
      if (row && row.product_type === 'request') {
        const { notify } = require("../services/notifications");
        await notify(
          Number(row.creator_id),
          "creator_sale",
          "New request!",
          `Someone just submitted a free request for ${row.product_title}.`,
          { product_id: row.product_id, order_id: row.order_id }
        );
      }
    } catch (e) {
      console.warn("free request notify warn:", e);
    }
    */

    // Redirect to success with a synthetic session id
    const successWithSid = successUrl.replace(
      "{CHECKOUT_SESSION_ID}",
      encodeURIComponent(freeSessionId)
    );
    return res.json({ url: successWithSid, id: freeSessionId });
  } else {
    // FREE membership: upsert an active membership row with a default 1-month period
    const currentPeriodEnd = (() => {
      const d = new Date();
      d.setMonth(d.getMonth() + 1);
      return d;
    })();

    try {
      await db.query(
        `
        INSERT INTO memberships
          (buyer_id, creator_id, product_id, stripe_subscription_id, status, cancel_at_period_end, current_period_end, created_at)
        VALUES ($1,$2,$3,$4,$5,FALSE,$6,NOW())
        ON CONFLICT (buyer_id, creator_id, product_id) DO UPDATE
          SET stripe_subscription_id = EXCLUDED.stripe_subscription_id,
              status                 = EXCLUDED.status,
              cancel_at_period_end   = FALSE,
              current_period_end     = EXCLUDED.current_period_end
        `,
        [buyerId, p.creator_id, p.id, freeSessionId, "active", currentPeriodEnd]
      );
    } catch (_) {}

    const successWithSid = successUrl.replace(
      "{CHECKOUT_SESSION_ID}",
      encodeURIComponent(freeSessionId)
    );
    return res.json({ url: successWithSid, id: freeSessionId });
  }
}
// ---- END FREE FLOW ----

const stripe = getStripe();
let session;

try {
  if (finalMode === "payment") {
    // ONE-TIME: Do NOT create DB order yet. We'll create it in finalize after success.
    const payload = {
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: p.title || p.product_type || "Item" },
            unit_amount: Number(p.price), // already cents in DB
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: Math.floor((Number(p.price) * PLATFORM_FEE_BPS) / 10000),
        metadata: { ...baseMetadata },
      },
      metadata: { ...baseMetadata },
      success_url: successUrl,
      cancel_url: cancelUrl,
    };

    session = await stripe.checkout.sessions.create(
      payload,
      clientKey
        ? { idempotencyKey: clientKey, stripeAccount: p.stripe_account_id }
        : { stripeAccount: p.stripe_account_id }
    );
  } else {
    // SUBSCRIPTION (memberships only)
    const payload = {
      mode: "subscription",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: p.title || "Membership" },
            recurring: { interval: "month" },
            unit_amount: Number(p.price), // cents
          },
          quantity: 1,
        },
      ],
      subscription_data: {
        application_fee_percent: PLATFORM_FEE_BPS / 100.0, // e.g. 4.0
        metadata: { ...baseMetadata },
      },
      metadata: { ...baseMetadata },
      success_url: successUrl,
      cancel_url: cancelUrl,
    };

    session = await stripe.checkout.sessions.create(
      payload,
      clientKey
        ? { idempotencyKey: clientKey, stripeAccount: p.stripe_account_id }
        : { stripeAccount: p.stripe_account_id }
    );
  }

  return res.json({ url: session.url, id: session.id });
} catch (err) {
  console.error("[checkout.create-session] error:", err?.raw || err);
  const msg = err?.raw?.message || err?.message || "Stripe error";
  return res.status(400).json({ error: msg });
}

  }
);

/**
 * GET /api/stripe-checkout/finalize?session_id=cs_...
 * Auth required (ensures the session belongs to this buyer).
 * Provides a resilient fallback in case webhooks were delayed or not yet configured.
 * Response shape consumed by frontend success page:
 *  { ok:true, type:"purchase"|"membership"|"request", creatorDisplayName:string, orderId:number|null }
 */
router.get("/finalize", requireAuth, async (req, res) => {
  const sessionId = String(req.query.session_id || req.query.sessionId || "").trim();
  if (!sessionId) return res.status(400).json({ ok: false, error: "session_id is required" });

    // Handle synthetic free sessions (no Stripe lookup)
    if (sessionId.startsWith("free_")) {
      const productIdForLookup = req.query.pid ? parseInt(String(req.query.pid), 10) : null;

      // Try to find an order created in the free purchase path
      let orderId = null;
      try {
        const { rows } = await db.query(
          `SELECT id, product_id FROM public.orders WHERE stripe_checkout_session_id=$1 LIMIT 1`,
          [sessionId]
        );
        if (rows.length) {
          orderId = rows[0].id;
        }
      } catch (_) {}

      // Helper to fetch creator name and product type
      async function getCreatorInfo(productId) {
        if (!productId) return { display_name: "Creator", product_type: null };
        const { rows } = await db.query(
          `SELECT cp.display_name, p.product_type
            FROM products p
        LEFT JOIN creator_profiles cp ON cp.user_id = p.user_id
            WHERE p.id = $1
            LIMIT 1`,
          [productId]
        );
        return rows[0] || { display_name: "Creator", product_type: null };
      }

      // Prefer pid from the query (present in success_url you built)
      const productId = productIdForLookup || null;
      const { display_name, product_type } = await getCreatorInfo(productId);
      const respType =
        (product_type === "membership") ? "membership" :
        (product_type === "request")    ? "request"    :
                                          "purchase";

      return res.json({
        ok: true,
        type: respType,
        creatorDisplayName: display_name || "Creator",
        orderId: orderId || null
      });
    }
  try {
    // Retrieve checkout session + expand to reduce round-trips
  const stripe = getStripe();
  // Prefer the connected acct passed via success URL (added at session creation).
 const acct = String(req.query.acct || "").trim() || null;
  const productIdForLookup = req.query.pid ? parseInt(String(req.query.pid), 10) : null;
  let session;
  if (!acct) {
    // Fallback: derive acct from product if acct not present in URL
    let derivedAcct = null;
    if (productIdForLookup) {
      const { rows: acctRow } = await db.query(
        `SELECT u.stripe_account_id
           FROM products p JOIN users u ON u.id = p.user_id
          WHERE p.id = $1 LIMIT 1`,
        [productIdForLookup]
      );
      derivedAcct = acctRow[0]?.stripe_account_id || null;
    }
    if (!derivedAcct) {
      return res.status(400).json({ ok: false, error: "Missing connected account context" });
    }
    session = await stripe.checkout.sessions.retrieve(
      sessionId,
      { expand: ["payment_intent", "subscription"] },
      { stripeAccount: derivedAcct }
    );
  } else {
    session = await stripe.checkout.sessions.retrieve(
      sessionId,
      { expand: ["payment_intent", "subscription"] },
      { stripeAccount: acct }
    );
  }

    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });

    const meta = session.metadata || {};
    const action = (meta.action || "").toLowerCase();
    const buyerIdMeta = meta.buyer_id && parseInt(meta.buyer_id, 10);
    if (buyerIdMeta && buyerIdMeta !== req.user.id) {
      return res.status(403).json({ ok: false, error: "Not your session" });
    }

    // Guard against a bad session path: requests/purchases must NOT be subscriptions
    if (session.mode === "subscription" && action !== "membership") {
      console.error("[finalize] Mode/action mismatch", { sessionMode: session.mode, action, meta });
      return res.status(400).json({ ok: false, error: "Checkout mode mismatch for this product" });
    }

    // Helper: fetch creator display name by product id
    async function getCreatorInfo(productId) {
      if (!productId) return { display_name: "Creator", product_type: null };
      const { rows } = await db.query(
        `SELECT cp.display_name, p.product_type
           FROM products p
      LEFT JOIN creator_profiles cp ON cp.user_id = p.user_id
          WHERE p.id = $1
          LIMIT 1`,
        [productId]
      );
      return rows[0] || { display_name: "Creator", product_type: null };
    }

    if (session.mode === "payment") {
      // Only create order after successful payment
      const paid = session.payment_status === "paid" || session.status === "complete";
      let finalOrderId = null;

    if (paid) {
      const productId = meta.product_id ? parseInt(meta.product_id, 10) : null;
      if (productId) {
        const amount = Number.isFinite(session.amount_total) ? Number(session.amount_total) : 0;
        const piId =
          (session.payment_intent && typeof session.payment_intent === "object"
            ? session.payment_intent.id
            : session.payment_intent) || null;

        // Idempotent write: one row per Stripe Checkout Session
        const upsertSql = `
          INSERT INTO public.orders
            (buyer_id, product_id, amount_cents, stripe_payment_intent_id, status, created_at, stripe_checkout_session_id)
          VALUES ($1,$2,$3,$4,'paid',NOW(),$5)
          ON CONFLICT (stripe_checkout_session_id) DO UPDATE
            SET amount_cents = EXCLUDED.amount_cents,
                stripe_payment_intent_id = COALESCE(EXCLUDED.stripe_payment_intent_id, public.orders.stripe_payment_intent_id),
                status = 'paid'
          RETURNING id
        `;

        try {
          const { rows } = await db.query(upsertSql, [req.user.id, productId, amount, piId, session.id]);
          finalOrderId = rows[0]?.id ?? null;
        } catch (err) {
          // Fallback read if the index wasn’t created yet or in a rare race
          console.error("[orders upsert] error → fallback lookup:", err);
          const { rows: existing } = await db.query(
            `SELECT id FROM public.orders WHERE stripe_checkout_session_id = $1 LIMIT 1`,
            [session.id]
          );
          finalOrderId = existing[0]?.id ?? null;
        }
      }
    }

      const productId = meta.product_id ? parseInt(meta.product_id, 10) : null;
      const { display_name, product_type } = await getCreatorInfo(productId);
      const respType = action || (product_type === "request" ? "request" : "purchase");
      return res.json({ ok: true, type: respType, creatorDisplayName: display_name || "Creator", orderId: finalOrderId });
    }

    if (session.mode === "subscription") {
      // Ensure we have customer saved
      if (session.customer) {
        await db.query(
          `UPDATE users SET stripe_customer_id=$1 WHERE id=$2 AND (stripe_customer_id IS NULL OR stripe_customer_id <> $1)`,
          [session.customer, req.user.id]
        );
      }

      // Upsert membership (mirrors webhook) if subscription object + metadata present
      const subscription = session.subscription && typeof session.subscription === "object" ? session.subscription : null;
      let subObj = subscription;
   if (!subObj && typeof session.subscription === "string") {
    try {
      if (acct) {
        subObj = await stripe.subscriptions.retrieve(
          session.subscription,
          {},
          { stripeAccount: acct }
        );
      } else {
        subObj = await stripe.subscriptions.retrieve(session.subscription);
      }
    } catch (_) { }
  }
      if (subObj && subObj.metadata) {
        const m = subObj.metadata;
        const buyerId = m.buyer_id && parseInt(m.buyer_id, 10);
        const creatorId = m.creator_id && parseInt(m.creator_id, 10);
        const productId = m.product_id && parseInt(m.product_id, 10);
        if (buyerId && creatorId && productId && buyerId === req.user.id) {
          // Calculate proper period end - either from Stripe or default to 1 month from now
          let currentPeriodEnd;
          if (subObj.current_period_end && subObj.current_period_end > 0) {
            currentPeriodEnd = new Date(subObj.current_period_end * 1000);
          } else {
            // Fallback: 1 month from now if Stripe doesn't provide valid period end
            currentPeriodEnd = new Date();
            currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
          }
          
          try {
              await db.query(
                `INSERT INTO memberships
                  (buyer_id, creator_id, product_id, stripe_subscription_id, status, cancel_at_period_end, current_period_end, created_at)
                VALUES ($1,$2,$3,$4,$5,FALSE,$6,NOW())
                ON CONFLICT (buyer_id, creator_id, product_id) DO UPDATE
                  SET stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                      status                 = EXCLUDED.status,
                      cancel_at_period_end   = FALSE,
                      current_period_end     = EXCLUDED.current_period_end`,
                [buyerId, creatorId, productId, subObj.id, subObj.status, currentPeriodEnd]
              );
          } catch (dbError) {
            console.error("Database error while creating membership:", dbError);
            // Continue processing - return success anyway since Stripe subscription is valid
          }
          const { display_name } = await getCreatorInfo(productId);
          return res.json({ ok: true, type: "membership", creatorDisplayName: display_name || "Creator", orderId: null });
        }
      }
      return res.json({ ok: true, type: "membership", creatorDisplayName: "Creator", orderId: null });
    }

    return res.status(400).json({ ok: false, error: "Unsupported session mode" });
    } catch (e) {
      console.error("Finalize error:", e);

      const msg = (() => {
        const m = (e && e.message) ? String(e.message) : "";
        const code = (e && e.code) ? String(e.code) : "";
        const looksDuplicate = /duplicate key/i.test(m) || code === "23505";

        // Only call it a subscription duplicate if we were actually finalizing a subscription
        if (looksDuplicate) {
          return "Duplicate record detected";
        }
        if (/not found/i.test(m)) {
          return "Session or related Stripe object not found";
        }
        return "Failed to finalize session";
      })();

      return res.status(500).json({ ok: false, error: msg });
    }
});

module.exports = router;
