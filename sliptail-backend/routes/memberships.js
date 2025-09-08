// routes/memberships.js
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { sendIfUserPref } = require("../utils/notify");

const router = express.Router();

/**
 * POST /api/memberships/subscribe
 * Body: { creator_id, product_id }
 * - Simulates a subscription purchase:
 *   - creates/updates a memberships row with status='active'
 *   - sets current_period_end = now + 1 month (MVP)
 * - Prevent subscribing to yourself
 * - Enforces one active membership per (buyer -> creator)
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
       ON CONFLICT (buyer_id, creator_id)
       DO UPDATE SET status='active',
                     cancel_at_period_end=FALSE,
                     product_id=EXCLUDED.product_id,
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
  } 
  
  catch (e) {
    console.error("subscribe error:", e);
    res.status(500).json({ error: "Could not start membership" });
  }
});

/**
 * POST /api/memberships/:id/cancel
 * - Marks cancel_at_period_end = TRUE
 * - Keeps access until current_period_end
 */
router.post("/:id/cancel", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const userId = req.user.id;

  try {
    // must be the owner
    const { rows: own } = await db.query(
      `SELECT * FROM memberships WHERE id=$1 AND buyer_id=$2`,
      [id, userId]
    );
    if (!own.length) return res.status(404).json({ error: "Membership not found" });

    const { rows } = await db.query(
      `UPDATE memberships
          SET cancel_at_period_end = TRUE
        WHERE id = $1
        RETURNING *`,
      [id]
    );
    res.json({ success: true, membership: rows[0] });
  } catch (e) {
    console.error("cancel error:", e);
    res.status(500).json({ error: "Could not cancel membership" });
  }
});

/**
 * GET /api/memberships/mine
 * - Lists my memberships with access flags
 */
router.get("/mine", requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await db.query(
      `SELECT m.*,
              (m.status IN ('active','trialing') AND NOW() <= m.current_period_end) AS has_access
         FROM memberships m
        WHERE m.buyer_id = $1
        ORDER BY m.current_period_end DESC`,
      [userId]
    );
    res.json({ memberships: rows });
  } catch (e) {
    console.error("mine error:", e);
    res.status(500).json({ error: "Could not fetch memberships" });
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
          AND status IN ('active','trialing')
          AND NOW() <= current_period_end
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