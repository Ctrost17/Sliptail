// backend/routes/checkout.js
const express = require("express");
const Stripe = require("stripe");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Prefer FRONTEND_URL; fall back to APP_URL; default to local Next dev URL
const FRONTEND_BASE = (
  process.env.FRONTEND_URL ||
  process.env.APP_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

/**
 * POST /api/checkout/session
 * Body: { product_id|productId, product_type|productType, quantity? }
 * Returns: { url }
 */
router.post("/session", requireAuth, async (req, res) => {
  const {
    product_id,
    productId,
    product_type,
    productType,
    quantity,
  } = req.body || {};

  const pid = parseInt(product_id || productId, 10);
  if (!pid) return res.status(400).json({ error: "product_id is required" });

  const qty = Math.max(1, parseInt(quantity || "1", 10));

  try {
    const { rows } = await db.query(
      `SELECT p.id,
              p.user_id              AS creator_id,
              p.title,
              p.description,
              p.product_type,
              p.price,
              u.email                AS creator_email,
              u.stripe_account_id    AS creator_stripe_account
         FROM products p
         JOIN users u ON u.id = p.user_id
        WHERE p.id=$1 AND p.active = TRUE
        LIMIT 1`,
      [pid]
    );
    if (!rows.length) return res.status(404).json({ error: "Product not found" });

    const prod = rows[0];
    const mode =
      (product_type || productType || prod.product_type) === "membership"
        ? "subscription"
        : "payment";

    const lineItem = {
      quantity: qty,
      price_data: {
        currency: "usd",
        unit_amount: Number(prod.price) || 0,
        product_data: {
          name: prod.title,
          description: prod.description || undefined,
        },
      },
    };
    if (mode === "subscription") {
      lineItem.price_data.recurring = { interval: "month" };
    }

    const success_url = `${FRONTEND_BASE}/purchases/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancel_url = `${FRONTEND_BASE}/creators/${prod.creator_id}?canceled=1`;

    const sessionParams = {
      mode,
      line_items: [lineItem],
      success_url,
      cancel_url,
      customer_email: req.user.email, // prefill with the signed-in user's email
      allow_promotion_codes: true,
      billing_address_collection: "auto",
    };

    // If using Stripe Connect to pay creators:
    if (prod.creator_stripe_account) {
      // Example 10% platform fee:
      const fee = Math.round((Number(prod.price) || 0) * 0.04);
      if (mode === "payment") {
        sessionParams.payment_intent_data = {
          application_fee_amount: fee,
          transfer_data: { destination: prod.creator_stripe_account },
        };
      } else {
        sessionParams.subscription_data = {
          application_fee_percent: 4,
          transfer_data: { destination: prod.creator_stripe_account },
        };
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.json({ url: session.url });
  } catch (e) {
    console.error("create checkout session error:", e);
    return res.status(500).json({ error: "Failed to start checkout" });
  }
});

module.exports = router;
