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
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: "Invalid price" });
    }

    const feeAmount = Math.floor((amountCents * PLATFORM_FEE_BPS) / 10000); // bps of price

    // Respect client URLs and append session id only if needed
    const successUrl = ensureSuccessUrl(success_url);
    const cancelUrl = ensureCancelUrl(cancel_url);

    // Derive an action label used by webhook/finalizer routing
    // - payment + product_type 'request' -> 'request'
    // - payment otherwise -> 'purchase'
    // - subscription -> 'membership'
    const productType = String(p.product_type || "").toLowerCase();
    const action =
      mode === "subscription"
        ? "membership"
        : productType === "request"
          ? "request"
          : "purchase";

    // Defensive: prevent obvious mode/type mismatch
    if (mode === "subscription" && productType === "download") {
      return res.status(400).json({ error: "This product is not a subscription" });
    }

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

    let session;

  const stripe = getStripe();
  if (mode === "payment") {
      // ONE-TIME: Do NOT create DB order yet. We'll create it in finalize after success.
      const payload = {
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: p.title || p.product_type || "Item" },
              unit_amount: amountCents, // cents
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          application_fee_amount: feeAmount,
          metadata: { ...baseMetadata },
        },
        metadata: { ...baseMetadata },
        success_url: successUrl, // -> /checkout/success?...session_id={CHECKOUT_SESSION_ID}
        cancel_url: cancelUrl,
      };

      // If client provides X-Idempotency-Key, use it; otherwise let Stripe create a fresh session
      if (clientKey) {
        session = await stripe.checkout.sessions.create(
          payload,
          { idempotencyKey: clientKey, stripeAccount: p.stripe_account_id }
        );
      } else {
        session = await stripe.checkout.sessions.create(
          payload,
          { stripeAccount: p.stripe_account_id }
        );
      }
    } else if (mode === "subscription") {
      // ────────────────────────────────────────────────────────────────────────────
      // SUBSCRIPTION: No orders row now; webhook/finalizer will upsert membership
      // ────────────────────────────────────────────────────────────────────────────

      const feePercent = PLATFORM_FEE_BPS / 100.0; // 400 -> 4.0%

      const payload = {
        mode: "subscription",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: p.title || "Membership" },
              recurring: { interval: "month" },
              unit_amount: amountCents, // cents
            },
            quantity: 1,
          },
        ],
        subscription_data: {
          application_fee_percent: feePercent,
          metadata: baseMetadata,
        },
        metadata: baseMetadata,
        success_url: successUrl, // -> /checkout/success?...session_id={CHECKOUT_SESSION_ID}
        cancel_url: cancelUrl,
      };

      // If client provides X-Idempotency-Key, use it; otherwise let Stripe create a fresh session
      if (clientKey) {
        session = await stripe.checkout.sessions.create(
          payload,
          { idempotencyKey: clientKey, stripeAccount: p.stripe_account_id }
        );
      } else {
        session = await stripe.checkout.sessions.create(
          payload,
          { stripeAccount: p.stripe_account_id }
        );
      }
    } else {
      return res.status(400).json({ error: "mode must be 'payment' or 'subscription'" });
    }

    return res.json({ url: session.url, id: session.id });
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

  try {
    // Retrieve checkout session + expand to reduce round-trips
  const stripe = getStripe();
  // First, peek once without opts to read metadata (works even on platform).
   let session = await stripe.checkout.sessions.retrieve(sessionId);
  const meta0 = session?.metadata || {};
  const productIdForLookup = meta0.product_id ? parseInt(meta0.product_id, 10) : null;

  // Look up the creator's stripe account by product
  let acct = null;
  if (productIdForLookup) {
    const { rows: acctRow } = await db.query(
      `SELECT u.stripe_account_id
         FROM products p JOIN users u ON u.id = p.user_id
         WHERE p.id = $1 LIMIT 1`,
      [productIdForLookup]
    );
    acct = acctRow[0]?.stripe_account_id || null;
  }

  // Re-retrieve from the CONNECTED account so expand works reliably
  if (acct) {
    session = await stripe.checkout.sessions.retrieve(
      sessionId,
      { expand: ["payment_intent", "subscription"] },
      { stripeAccount: acct }
    );
  } else {
    // fall back (shouldn't happen if product_id is present)
    session = await stripe.checkout.sessions.retrieve(
      sessionId,
      { expand: ["payment_intent", "subscription"] }
    );
  }

    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });

    const meta = session.metadata || {};
    const action = (meta.action || "").toLowerCase();
    const buyerIdMeta = meta.buyer_id && parseInt(meta.buyer_id, 10);
    if (buyerIdMeta && buyerIdMeta !== req.user.id) {
      return res.status(403).json({ ok: false, error: "Not your session" });
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
          const { rows } = await db.query(
            `INSERT INTO public.orders (buyer_id, product_id, amount_cents, stripe_payment_intent_id, status, created_at, stripe_checkout_session_id)
             VALUES ($1,$2,$3,$4,'paid',NOW(),$5)
             RETURNING id`,
            [req.user.id, productId, amount, session.payment_intent || null, session.id]
          );
          finalOrderId = rows[0].id;
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
    
    // Provide more specific error messages based on error type
    let errorMessage = "Failed to finalize session";
    if (e.message && e.message.includes("duplicate key")) {
      errorMessage = "Subscription already exists";
    } else if (e.message && e.message.includes("not found")) {
      errorMessage = "Session or subscription not found";
    } else if (e.code === "23505") {
      errorMessage = "Duplicate subscription detected";
    }
    
    return res.status(500).json({ ok: false, error: errorMessage });
  }
});

module.exports = router;
