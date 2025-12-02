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
const jwt = require("jsonwebtoken");

const router = express.Router();

/* ------------------------------ helpers ------------------------------ */

async function getOptionalBuyer(req) {
  let token = null;

  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }
  if (!token && req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return { buyerId: null, hadToken: false };
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = payload.id || payload.userId;
    if (!userId) {
      return { buyerId: null, hadToken: true };
    }

    const { rows } = await db.query(
      "SELECT id, is_active FROM users WHERE id = $1 LIMIT 1",
      [userId]
    );
    const row = rows[0];
    if (!row || row.is_active === false) {
      return { buyerId: null, hadToken: true };
    }
    return { buyerId: row.id, hadToken: true };
  } catch {
    return { buyerId: null, hadToken: true };
  }
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("Stripe not configured: missing STRIPE_SECRET_KEY");
  }
  return Stripe(key);
}

// 4% fee in basis points (default 400 bps)
const PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "400", 10);

// NOTE: products.price is integer cents in your DB. Do NOT multiply by 100 again.

// Success/cancel fallback URLs (frontend can override in body)
const FRONTEND = (process.env.FRONTEND_URL || "http://localhost:3000").replace(
  /\/$/,
  ""
);

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

/* ---------------------------------------------------------------------- */
/*                        create-session (guest ok)                       */
/* ---------------------------------------------------------------------- */

/**
 * POST /api/stripe-checkout/create-session
 * body: { product_id: number, mode: "payment"|"subscription", success_url?, cancel_url? }
 *
 * - Guests are allowed for purchases and requests
 * - Memberships require login
 * - If logged in, we still attach buyer_id to metadata
 */
router.post(
  "/create-session",
  strictLimiter,
  validate(checkoutSession),
  async (req, res) => {
    const { buyerId } = await getOptionalBuyer(req);
    const {
      product_id,
      mode, // "payment" for purchase/request, "subscription" for membership (ignored, we compute from product_type)
      success_url,
      cancel_url,
    } = req.body || {};

    // 1) Load product and creator Stripe connect account
    const { rows } = await db.query(
      `
      SELECT
        p.id,
        p.title,
        p.product_type,       -- e.g. 'download' | 'request' | 'membership'
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
      return res
        .status(400)
        .json({ error: "Creator has not completed Stripe onboarding" });
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
      productType === "membership"
        ? "membership"
        : productType === "request"
        ? "request"
        : "purchase";

    const finalMode = productType === "membership" ? "subscription" : "payment";
    console.log(
      "[checkout] product_type:",
      productType,
      "finalMode:",
      finalMode,
      "reqMode:",
      mode
    );
    // Memberships require a logged in user to avoid duplicate subscriptions
    if (finalMode === "subscription" && !buyerId) {
      return res
        .status(401)
        .json({ error: "Please log in to subscribe to this membership." });
    }

    // Decide where Stripe should send the user after checkout:
    // - Guests buying one-time products → signed-out success page
    // - Logged-in buyers (or any membership) → auth success flow that pushes to My Purchases
    const isGuest = !buyerId;
    const isMembership = finalMode === "subscription";

    const defaultSuccessPath =
      isGuest && !isMembership ? "/checkout/signed-out" : "/checkout/success";

    // Build success URL with just pid (no acct, because sessions now live on the platform account)
    const baseSuccess = ensureSuccessUrl(success_url, defaultSuccessPath);
    const sep = baseSuccess.includes("?") ? "&" : "?";
    const successUrl = `${baseSuccess}${sep}pid=${encodeURIComponent(p.id)}`;

    const baseCancel = ensureCancelUrl(cancel_url);
    const csep = baseCancel.includes("?") ? "&" : "?";
    const cancelUrl = `${baseCancel}${csep}pid=${encodeURIComponent(
      p.id
    )}&action=${encodeURIComponent(action)}`;

    // Common metadata we want to see again in webhooks / subscription events
    const baseMetadata = {
      action, // "purchase" | "request" | "membership"
      product_id: String(p.id),
      product_type: String(p.product_type || ""),
      creator_id: String(p.creator_id),
      buyer_id: buyerId ? String(buyerId) : "", // guests do not have a Sliptail user yet
    };

    // Optional client-provided idempotency key
    const clientKey = req.get("x-idempotency-key");

    /* -------------------------- FREE FLOW (no Stripe) -------------------------- */

    if (amountCents === 0) {
  // Guests must log in for free products, since we do not collect email without Stripe
      if (!buyerId) {
        return res
      .status(401)
      .json({ error: "Please log in to claim this free product." });
        }
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

    /* ------------------------------ STRIPE FLOW ------------------------------ */

    const stripe = getStripe();
      let session;

    // Message that appears on Stripe Checkout
    const EMAIL_HINT =
      "Please double check your email. This is where your access will be sent.";

    // Only show warning description if guest + one time purchase/request + paid product
    const shouldShowEmailWarning =
      !buyerId && finalMode === "payment" && amountCents > 0;

    const productDescription = shouldShowEmailWarning
      ? "⚠️ Make sure your email is correct so we can send you access!"
      : undefined; // Stripe will omit undefined fields

    try {
        if (finalMode === "payment") {
          // ONE-TIME: do not create DB order yet. Webhook or finalize will handle it.
          const payload = {
            mode: "payment",
            line_items: [
              {
                price_data: {
                  currency: "usd",
                  product_data: {
                    name: p.title || p.product_type || "Item",
                    ...(productDescription
                      ? { description: productDescription }
                      : {}),
                  },
                  unit_amount: Number(p.price), // already cents in DB
                },
                quantity: 1,
              },
            ],
            // No application_fee_amount here anymore – charge happens on the platform account
            payment_intent_data: {
              metadata: { ...baseMetadata },
            },
            metadata: { ...baseMetadata },
            success_url: successUrl,
            cancel_url: cancelUrl,
            custom_text: {
              submit: {
                message: EMAIL_HINT,
              },
            },
          };

          // Create session on the PLATFORM account (no stripeAccount override)
          if (clientKey) {
            session = await stripe.checkout.sessions.create(payload, {
              idempotencyKey: clientKey,
            });
          } else {
            session = await stripe.checkout.sessions.create(payload);
          }
        } else {
          // SUBSCRIPTION (memberships only) – create on PLATFORM account
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
            // No application_fee_percent – platform fee will be handled via transfers from invoices later
            subscription_data: {
              metadata: { ...baseMetadata },
            },
            metadata: { ...baseMetadata },
            success_url: successUrl,
            cancel_url: cancelUrl,
            custom_text: {
              submit: {
                message: EMAIL_HINT,
              },
            },
          };

          // Create session on PLATFORM account
          if (clientKey) {
            session = await stripe.checkout.sessions.create(payload, {
              idempotencyKey: clientKey,
            });
          } else {
            session = await stripe.checkout.sessions.create(payload);
          }
        }

      return res.json({ url: session.url, id: session.id });
    } catch (err) {
      console.error("[checkout.create-session] error:", err?.raw || err);
      const msg = err?.raw?.message || err?.message || "Stripe error";
      return res.status(400).json({ error: msg });
    }
  }
);

/* ---------------------------------------------------------------------- */
/*                            finalize (logged in)                        */
/* ---------------------------------------------------------------------- */

/**
 * GET /api/stripe-checkout/finalize?session_id=cs_...
 * Auth required (ensures the session belongs to this buyer).
 * Provides a resilient fallback in case webhooks were delayed or not yet configured.
 * Response shape consumed by frontend success page:
 *  { ok:true, type:"purchase"|"membership"|"request", creatorDisplayName:string, orderId:number|null }
 */
router.get("/finalize", requireAuth, async (req, res) => {
  const sessionId = String(
    req.query.session_id || req.query.sessionId || ""
  ).trim();
  if (!sessionId)
    return res
      .status(400)
      .json({ ok: false, error: "session_id is required" });

  // Handle synthetic free sessions (no Stripe lookup)
  if (sessionId.startsWith("free_")) {
    const productIdForLookup = req.query.pid
      ? parseInt(String(req.query.pid), 10)
      : null;

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
      product_type === "membership"
        ? "membership"
        : product_type === "request"
        ? "request"
        : "purchase";

    return res.json({
      ok: true,
      type: respType,
      creatorDisplayName: display_name || "Creator",
      orderId: orderId || null,
    });
  }

  try {
      const stripe = getStripe();
      const acct = String(req.query.acct || "").trim() || null;
      const productIdForLookup = req.query.pid
        ? parseInt(String(req.query.pid), 10)
        : null;

      const expandConfig = { expand: ["payment_intent", "subscription"] };

      // Legacy support: we may still have older sessions created on a connected account
      let derivedAcct = null;
      if (!acct && productIdForLookup) {
        try {
          const { rows: acctRow } = await db.query(
            `SELECT u.stripe_account_id
              FROM products p JOIN users u ON u.id = p.user_id
              WHERE p.id = $1 LIMIT 1`,
            [productIdForLookup]
          );
          derivedAcct = acctRow[0]?.stripe_account_id || null;
        } catch (_) {
          derivedAcct = null;
        }
      }

      let session;
      try {
        // New flow: sessions live on the PLATFORM account
        session = await stripe.checkout.sessions.retrieve(sessionId, expandConfig);
      } catch (err) {
        const code = err && (err.code || err?.raw?.code);
        const isMissing = code === "resource_missing";
        const fallbackAcct = acct || derivedAcct;

        if (!isMissing || !fallbackAcct) {
          // If it's not a simple "missing" on platform, or we have no connected acct to try, rethrow
          throw err;
        }

        // Legacy flow: session was created on a connected account
        session = await stripe.checkout.sessions.retrieve(
          sessionId,
          expandConfig,
          { stripeAccount: fallbackAcct }
        );
      }

    if (!session)
      return res.status(404).json({ ok: false, error: "Session not found" });

    const meta = session.metadata || {};
    const action = (meta.action || "").toLowerCase();
    const buyerIdMeta = meta.buyer_id && parseInt(meta.buyer_id, 10);
    if (buyerIdMeta && buyerIdMeta !== req.user.id) {
      return res
        .status(403)
        .json({ ok: false, error: "Not your session" });
    }

    // Guard against a bad session path: requests/purchases must NOT be subscriptions
    if (session.mode === "subscription" && action !== "membership") {
      console.error("[finalize] Mode/action mismatch", {
        sessionMode: session.mode,
        action,
        meta,
      });
      return res
        .status(400)
        .json({ ok: false, error: "Checkout mode mismatch for this product" });
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
      const paid =
        session.payment_status === "paid" || session.status === "complete";
      let finalOrderId = null;

      if (paid) {
        const productId = meta.product_id
          ? parseInt(meta.product_id, 10)
          : null;
        if (productId) {
          const amount = Number.isFinite(session.amount_total)
            ? Number(session.amount_total)
            : 0;
          const piId =
            (session.payment_intent &&
            typeof session.payment_intent === "object"
              ? session.payment_intent.id
              : session.payment_intent) || null;

          // Idempotent write: one row per Stripe Checkout Session
          const upsertSql = `
            INSERT INTO public.orders
              (buyer_id, product_id, amount_cents, stripe_payment_intent_id, status, created_at, stripe_checkout_session_id)
            VALUES ($1,$2,$3,$4,'paid',NOW(),$5)
            ON CONFLICT (stripe_checkout_session_id) DO UPDATE
              SET buyer_id = COALESCE(public.orders.buyer_id, EXCLUDED.buyer_id),
                  amount_cents = EXCLUDED.amount_cents,
                  stripe_payment_intent_id = COALESCE(EXCLUDED.stripe_payment_intent_id, public.orders.stripe_payment_intent_id),
                  status = 'paid'
            RETURNING id
          `;

          try {
            const { rows } = await db.query(upsertSql, [
              req.user.id,
              productId,
              amount,
              piId,
              session.id,
            ]);
            finalOrderId = rows[0]?.id ?? null;
          } catch (err) {
            // Fallback read if the index was not created yet or in a rare race
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
      const respType =
        action ||
        (product_type === "request" ? "request" : "purchase");
      return res.json({
        ok: true,
        type: respType,
        creatorDisplayName: display_name || "Creator",
        orderId: finalOrderId,
      });
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
      const subscription =
        session.subscription && typeof session.subscription === "object"
          ? session.subscription
          : null;
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
            subObj = await stripe.subscriptions.retrieve(
              session.subscription
            );
          }
        } catch (_) {}
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
            console.error(
              "Database error while creating membership:",
              dbError
            );
            // Continue processing - return success anyway since Stripe subscription is valid
          }
          const { display_name } = await getCreatorInfo(productId);
          return res.json({
            ok: true,
            type: "membership",
            creatorDisplayName: display_name || "Creator",
            orderId: null,
          });
        }
      }
      return res.json({
        ok: true,
        type: "membership",
        creatorDisplayName: "Creator",
        orderId: null,
      });
    }

    return res
      .status(400)
      .json({ ok: false, error: "Unsupported session mode" });
  } catch (e) {
    console.error("Finalize error:", e);

    const msg = (() => {
      const m = e && e.message ? String(e.message) : "";
      const code = e && e.code ? String(e.code) : "";
      const looksDuplicate =
        /duplicate key/i.test(m) || code === "23505";

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
