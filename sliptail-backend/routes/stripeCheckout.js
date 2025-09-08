const express = require("express");
const Stripe = require("stripe");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { checkoutSession } = require("../validators/schemas");
const { strictLimiter } = require("../middleware/rateLimit");

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// 4% fee in basis points (default 400 bps)
const PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "400", 10);

// util: dollars -> cents (int)
const toCents = (n) => Math.round(Number(n) * 100);

// Success/cancel fallback URLs (frontend can override in body)
const FRONTEND = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/,"");

/**
 * POST /api/stripe-checkout/create-session
 * body: { product_id: number, mode: "payment"|"subscription", success_url?, cancel_url? }
 */
router.post("/create-session", requireAuth, strictLimiter, validate(checkoutSession), async (req, res) => {
  const buyerId = req.user.id;
  const {
    product_id,
    mode,                   // "payment" for purchase/request, "subscription" for membership
    success_url,            // optional overrides
    cancel_url
  } = req.body || {};

  // 1) load product and creator’s connect account
  const { rows } = await db.query(
    `SELECT p.id, p.title, p.product_type, p.price, p.user_id AS creator_id,
            u.stripe_account_id
       FROM products p
       JOIN users u ON u.id = p.user_id
      WHERE p.id=$1`,
    [product_id]
  );
  const p = rows[0];
  if (!p) return res.status(404).json({ error: "Product not found" });

  if (!p.stripe_account_id) {
    return res.status(400).json({ error: "Creator has not completed Stripe onboarding" });
  }

 const amountCents = Math.round(Number(p.price) || 0);
  if (amountCents <= 0) return res.status(400).json({ error: "Invalid price" });

  const feeAmount = Math.floor((amountCents * PLATFORM_FEE_BPS) / 10000); // e.g., 400 bps of price

  const successUrl = success_url || `${FRONTEND}/checkout/success`;
  const cancelUrl  = cancel_url  || `${FRONTEND}/checkout/cancel`;

  // Common metadata we want to see again in webhooks
  const baseMetadata = {
    product_id: String(p.id),
    product_type: p.product_type,
    creator_id: String(p.creator_id),
    buyer_id: String(buyerId)
  };

  // Optional client-provided idempotency key
  const clientKey = req.get("x-idempotency-key");

  let session;

  if (mode === "payment") {
    // For purchase or request (one-time)
    // Create a pending order we will mark 'paid' in the webhook.
    const { rows: ord } = await db.query(
      `INSERT INTO orders (buyer_id, product_id, amount, status, created_at)
       VALUES ($1,$2,$3,'pending',NOW())
       RETURNING id`,
      [buyerId, p.id, (amountCents / 100).toFixed(2)]
    );
    const orderId = ord[0].id;

    const payload = {
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: p.title || p.product_type },
          unit_amount: amountCents
        },
        quantity: 1
      }],
      payment_intent_data: {
        application_fee_amount: feeAmount,
        transfer_data: { destination: p.stripe_account_id },
        metadata: { ...baseMetadata, order_id: String(orderId) }
      },
      metadata: { ...baseMetadata, order_id: String(orderId) },
      success_url: successUrl + "?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: cancelUrl
    };

    // Use client key if provided, else a stable order-based key
    const idempotencyKey = clientKey || `co_${orderId}`;

    session = await stripe.checkout.sessions.create(payload, { idempotencyKey });

    // stash session id on the order (useful for support)
    await db.query(
      `UPDATE orders SET stripe_checkout_session_id=$1 WHERE id=$2`,
      [session.id, orderId]
    );

  } else if (mode === "subscription") {
    // Membership (recurring). We'll charge monthly by default.
    // For Connect subscriptions, use application_fee_percent and destination.
    const feePercent = PLATFORM_FEE_BPS / 100.0; // 400 -> 4.0%

    const payload = {
      mode: "subscription",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: p.title || "Membership" },
          recurring: { interval: "month" },
          unit_amount: amountCents
        },
        quantity: 1
      }],
      subscription_data: {
        application_fee_percent: feePercent,
        transfer_data: { destination: p.stripe_account_id },
        metadata: baseMetadata
      },
      metadata: baseMetadata,
      success_url: successUrl + "?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: cancelUrl
    };

    // For subs we don’t have an order row yet, so build a stable key per buyer+product.
    // If you want multiple concurrent subs to the same product, pass a unique X-Idempotency-Key from the client.
    const idempotencyKey = clientKey || `sub_${buyerId}_${p.id}`;

    session = await stripe.checkout.sessions.create(payload, { idempotencyKey });

    // We do NOT create a DB row here; the webhook will upsert memberships.
  } else {
    return res.status(400).json({ error: "mode must be 'payment' or 'subscription'" });
  }

  return res.json({ url: session.url, id: session.id });
});

module.exports = router;