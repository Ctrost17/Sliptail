// routes/memberships.js
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendIfUserPref } = require("../utils/notify");

// ✅ NEW: Stripe (needed so cancel actually stops future charges on Stripe)
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

// Build secure product links, mirroring orders route
function linkify(product) {
  if (!product) return null;
  const id = product.id;
  return {
    ...product,
    view_url: `/api/downloads/view/${id}`,
    download_url: `/api/downloads/file/${id}`,
  };
}

/**
 * POST /api/memberships/subscribe
 * Body: { creator_id, product_id }
 * - Simulates a subscription purchase
 */
router.post("/subscribe", requireAuth, async (req, res) => {
  const buyerId = req.user.id;
  const { creator_id, product_id } = req.body;

  if (!creator_id || !product_id) {
    return res.status(400).json({ error: "creator_id and product_id are required" });
  }
  if (Number(creator_id) === buyerId) {
    return res.status(400).json({ error: "You cannot subscribe to yourself" });
  }

  try {
    // validate product belongs to creator and is a membership product
    const { rows: prodRows } = await db.query(
      `SELECT id, user_id AS creator_id, product_type, price
         FROM products
        WHERE id=$1`,
      [product_id]
    );
    const p = prodRows[0];
    if (!p) return res.status(404).json({ error: "Product not found" });
    if (p.creator_id !== Number(creator_id)) {
      return res.status(400).json({ error: "Product does not belong to this creator" });
    }
    if (p.product_type !== "membership") {
      return res.status(400).json({ error: "Product is not a membership" });
    }

    // Simulate an initial 1-month period
    const { rows } = await db.query(
      `INSERT INTO memberships (buyer_id, creator_id, product_id, status, cancel_at_period_end, current_period_end, started_at)
       VALUES ($1,$2,$3,'active',FALSE, NOW() + INTERVAL '1 month', NOW())
       ON CONFLICT (buyer_id, creator_id, product_id)
       DO UPDATE SET status='active',
                     cancel_at_period_end=FALSE,
                     current_period_end = GREATEST(memberships.current_period_end, NOW()) + INTERVAL '1 month'
       RETURNING *`,
      [buyerId, creator_id, product_id]
    );

    res.status(201).json({ success: true, membership: rows[0] });
    // buyer: confirmation
    sendIfUserPref(buyerId, "notify_purchase", {
      subject: "Your membership is active",
      html: `<p>Your membership is active. Enjoy the content!</p>`,
      category: "membership_purchase"
    }).catch(console.error);

    // creator: sale notice
    sendIfUserPref(creator_id, "notify_product_sale", {
      subject: "New membership subscriber",
      html: `<p>You have a new/renewed subscriber.</p>`,
      category: "creator_sale"
    }).catch(console.error);
  } catch (e) {
    console.error("subscribe error:", e);

    let errorMessage = "Could not start membership";
    if (e.code === "23505" || (e.message && e.message.includes("duplicate key"))) {
      errorMessage = "Membership already exists";
    }

    res.status(500).json({ error: errorMessage });
  }
});

/**
 * POST /api/memberships/:id/cancel
 * - Marks cancel_at_period_end = TRUE
 * - Keeps access until current_period_end
 * - ✅ UPDATED: If a Stripe subscription exists, set cancel_at_period_end on Stripe too
 */
router.post("/:id/cancel", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const userId = req.user.id;

  try {
    // must be the owner; also fetch stripe_subscription_id if present
    const { rows: own } = await db.query(
      `SELECT id, buyer_id, stripe_subscription_id
         FROM memberships
        WHERE id=$1 AND buyer_id=$2`,
      [id, userId]
    );
    const m = own[0];
    if (!m) return res.status(404).json({ error: "Membership not found" });

    let stripeStatus = null;
    let stripeCancelsAt = null;

    // If linked to Stripe, cancel there at period end (this stops future renewals)
    if (m.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.update(m.stripe_subscription_id, {
          cancel_at_period_end: true,
        });
        stripeStatus = sub.status; // likely 'active' or 'trialing'
        stripeCancelsAt = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;

        // Mirror Stripe on our row
        await db.query(
          `UPDATE memberships
              SET cancel_at_period_end = TRUE,
                  current_period_end   = COALESCE($2, current_period_end),
                  status               = $3
            WHERE id = $1`,
          [id, stripeCancelsAt, stripeStatus]
        );
      } catch (stripeErr) {
        console.error("Stripe cancel_at_period_end failed:", stripeErr);
        // If Stripe call fails, we *do not* flip local state, to avoid lying to the user.
        return res.status(502).json({ error: "Stripe cancellation failed. Please try again." });
      }
    } else {
      // No Stripe link — mark local cancel-at-period-end only
      await db.query(
        `UPDATE memberships
            SET cancel_at_period_end = TRUE
          WHERE id = $1`,
        [id]
      );
    }

    const { rows: updated } = await db.query(`SELECT * FROM memberships WHERE id=$1`, [id]);
    return res.json({
      success: true,
      membership: updated[0],
      note: m.stripe_subscription_id
        ? "Stripe subscription will not renew; access continues until current_period_end."
        : "Local-only cancel marked; no Stripe subscription linked.",
    });
  } catch (e) {
    console.error("cancel error:", e);
    res.status(500).json({ error: "Could not cancel membership" });
  }
});

/**
 * GET /api/memberships/mine
 * - Lists my memberships with access flags
 * - 👇 Keeps showing memberships that are scheduled to cancel, until current_period_end passes.
 */
router.get("/mine", requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await db.query(
      `SELECT m.*,
              /* Access if still paid through OR in an active-ish status */
              (
                (
                  m.status IN ('active','trialing','past_due')
                )
                OR (
                  m.cancel_at_period_end = TRUE
                  AND COALESCE(m.current_period_end, NOW()) >= NOW()
                )
              )
              AND (m.current_period_end IS NULL OR m.current_period_end >= NOW())
              AS has_access,
                  EXISTS (
                    SELECT 1
                      FROM reviews r
                      WHERE r.buyer_id = $1
                        AND (
                              /* count a review tied to this membership product */
                              r.product_id = p.id
                          OR (
                              /* also count a creator-level review (no product) */
                              r.product_id IS NULL
                          AND r.creator_id = p.user_id
                            )
                            )
                      LIMIT 1
                  ) AS user_has_review,
              json_build_object(
                'id', p.id,
                'user_id', p.user_id,
                'title', p.title,
                'description', p.description,
                'filename', p.filename,
                'product_type', p.product_type,
                'price', p.price,
                'created_at', p.created_at
              ) AS product,
              json_build_object(
                'user_id', c.user_id,
                'display_name', c.display_name,
                'bio', c.bio,
                'profile_image', c.profile_image
              ) AS creator_profile
         FROM memberships m
         JOIN products p ON p.id = m.product_id
         JOIN creator_profiles c ON c.user_id = p.user_id
        WHERE m.buyer_id = $1
          AND (
                m.status IN ('active','trialing','past_due')
             OR (m.cancel_at_period_end = TRUE AND COALESCE(m.current_period_end, NOW()) >= NOW())
          )
        ORDER BY m.current_period_end DESC`,
      [userId]
    );

    const withLinks = rows.map(r => ({
      ...r,
      product: linkify(r.product),
    }));

    res.json({ memberships: withLinks });
  } catch (e) {
    console.error("mine error:", e);
    res.status(500).json({ error: "Could not fetch memberships" });
  }
});

/**
 * GET /api/memberships/feed
 * - Same as /mine but only returns memberships with has_access=true
 * - Optimized for feed page so client doesn’t have to filter
 */
router.get("/feed", requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const baseQuery = `SELECT p.id,
                              p.user_id AS creator_id,
                              p.title,
                              p.description,
                              p.filename,
                              p.product_type,
                              p.price,
                              p.created_at
                         FROM products p
                        WHERE p.user_id = $1
                          AND p.product_type = 'membership'
                          AND COALESCE(p.active, TRUE) = TRUE
                        ORDER BY p.created_at DESC`;
    const { rows } = await db.query(baseQuery, [userId]);
    const products = rows.map(linkify);

    res.json({ products, count: products.length });
  } catch (e) {
    console.error("feed products error:", e);
    res.status(500).json({ error: "Could not fetch feed products" });
  }
});

/**
 * GET /api/memberships/subscribed-products
 * - Returns membership products the current user is subscribed to (other creators)
 * - Allows cancel_at_period_end=TRUE but still within access window
 */
router.get("/subscribed-products", requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT p.id,
              p.user_id,
              p.title,
              p.description,
              p.filename,
              p.product_type,
              p.price,
              p.created_at,
              cp.display_name,
              cp.profile_image
         FROM memberships m
         JOIN products p ON p.id = m.product_id
         JOIN creator_profiles cp ON cp.user_id = p.user_id
        WHERE m.buyer_id = $1
          AND (
                m.status IN ('active','trialing','past_due')
             OR (m.cancel_at_period_end = TRUE AND COALESCE(m.current_period_end, NOW()) >= NOW())
          )
          AND (m.current_period_end IS NULL OR NOW() <= m.current_period_end)
        ORDER BY p.created_at DESC`,
      [userId]
    );
    const products = rows.map(linkify);
    return res.json({ products, count: products.length });
  } catch (e) {
    console.error("subscribed-products error:", e);
    return res.status(500).json({ error: "Could not fetch subscribed products" });
  }
});

/**
 * Helper endpoint (optional) to check access to a creator's feed
 * GET /api/memberships/access/:creatorId
 */
router.get("/access/:creatorId", requireAuth, async (req, res) => {
  const creatorId = parseInt(req.params.creatorId, 10);
  const userId = req.user.id;
  try {
    const { rows } = await db.query(
      `SELECT 1
         FROM memberships
        WHERE buyer_id=$1 AND creator_id=$2
          AND (
                m.status IN ('active','trialing','past_due')
             OR (m.cancel_at_period_end = TRUE AND COALESCE(m.current_period_end, NOW()) >= NOW())
          )
          AND (current_period_end IS NULL OR NOW() <= current_period_end)
        LIMIT 1`,
      [userId, creatorId]
    );
    res.json({ has_access: !!rows.length });
  } catch (e) {
    console.error("access error:", e);
    res.status(500).json({ error: "Access check failed" });
  }
});

module.exports = router;
