// routes/stripeCheckout.js
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

    if (mode === "payment") {
      // ────────────────────────────────────────────────────────────────────────────
      // ONE-TIME: Create a PENDING order now; mark it PAID in webhook/finalizer
      // ────────────────────────────────────────────────────────────────────────────

      // DB matches your schema: amount_cents integer NOT NULL
      const { rows: ord } = await db.query(
        `
        INSERT INTO public.orders
          (buyer_id, product_id, amount_cents, status, created_at)
        VALUES
          ($1, $2, $3, 'pending', NOW())
        RETURNING id
        `,
        [buyerId, p.id, amountCents]
      );
      const orderId = ord[0].id;

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
          transfer_data: { destination: p.stripe_account_id },
          metadata: { ...baseMetadata, order_id: String(orderId) },
        },
        metadata: { ...baseMetadata, order_id: String(orderId) },
        success_url: successUrl, // -> /checkout/success?...session_id={CHECKOUT_SESSION_ID}
        cancel_url: cancelUrl,
      };

      // Use client key if provided; else a stable order-based key
      const idempotencyKey = clientKey || `co_${orderId}`;

      session = await stripe.checkout.sessions.create(payload, { idempotencyKey });

      // Stash session id on the order (useful for support and request form)
      await db.query(
        `UPDATE public.orders SET stripe_checkout_session_id = $1 WHERE id = $2`,
        [session.id, orderId]
      );
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
          transfer_data: { destination: p.stripe_account_id },
          metadata: baseMetadata,
        },
        metadata: baseMetadata,
        success_url: successUrl, // -> /checkout/success?...session_id={CHECKOUT_SESSION_ID}
        cancel_url: cancelUrl,
      };

      // If you want multiple concurrent subs to same product, provide unique X-Idempotency-Key from client
      const idempotencyKey = clientKey || `sub_${buyerId}_${p.id}`;
      session = await stripe.checkout.sessions.create(payload, { idempotencyKey });
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
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "subscription"],
    });

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
      // Attempt to mark the related order paid (mirrors webhook logic) if payment succeeded.
      const paid = session.payment_status === "paid" || session.status === "complete";
      const orderId = meta.order_id ? parseInt(meta.order_id, 10) : null;
      let finalOrderId = orderId;

      if (paid && orderId) {
        await db.query(
          `UPDATE public.orders
              SET status='paid',
                  stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $1),
                  stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $2)
            WHERE id=$3 AND status <> 'paid'`,
          [session.payment_intent || null, session.id, orderId]
        );
      }

      // Fallback: if we somehow never created the pending order (edge), create it now.
      if (paid && !finalOrderId) {
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
          `UPDATE users SET stripe_customer_id=$1 WHERE id=$2 AND (stripe_customer_id IS NULL OR stripe_customer_id <> $1)` ,
          [session.customer, req.user.id]
        );
      }

      // Upsert membership (mirrors webhook) if subscription object + metadata present
      const subscription = session.subscription && typeof session.subscription === "object" ? session.subscription : null;
      let subObj = subscription;
      if (!subObj && typeof session.subscription === "string") {
        try { subObj = await stripe.subscriptions.retrieve(session.subscription); } catch(_) {}
      }
      if (subObj && subObj.metadata) {
        const m = subObj.metadata;
        const buyerId = m.buyer_id && parseInt(m.buyer_id, 10);
        const creatorId = m.creator_id && parseInt(m.creator_id, 10);
        const productId = m.product_id && parseInt(m.product_id, 10);
        if (buyerId && creatorId && productId && buyerId === req.user.id) {
          const currentPeriodEnd = new Date((subObj.current_period_end || 0) * 1000);
          await db.query(
            `INSERT INTO memberships (buyer_id, creator_id, product_id, stripe_subscription_id, status, current_period_end, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,NOW())
             ON CONFLICT (stripe_subscription_id) DO UPDATE
               SET status=EXCLUDED.status,
                   current_period_end=EXCLUDED.current_period_end`,
            [buyerId, creatorId, productId, subObj.id, subObj.status, currentPeriodEnd]
          );
          const { display_name } = await getCreatorInfo(productId);
          return res.json({ ok: true, type: "membership", creatorDisplayName: display_name || "Creator", orderId: null });
        }
      }
      return res.json({ ok: true, type: "membership", creatorDisplayName: "Creator", orderId: null });
    }

    return res.status(400).json({ ok: false, error: "Unsupported session mode" });
  } catch (e) {
    console.error("Finalize error:", e);
    return res.status(500).json({ ok: false, error: "Failed to finalize session" });
  }
});

module.exports = router;
