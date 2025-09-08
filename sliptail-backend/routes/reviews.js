const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// ---------- helpers ----------
async function hasEligibility(buyerId, creatorId, productId) {
  // (A) Paid purchase of this creator's product (optionally same product_id)
  const paidPurchase = await db.query(
    `
    SELECT 1
      FROM orders o
      JOIN products p ON p.id = o.product_id
     WHERE o.buyer_id = $1
       AND p.user_id  = $2
       AND o.status   = 'paid'
       ${productId ? "AND p.id = $3" : ""}
     LIMIT 1
    `,
    productId ? [buyerId, creatorId, productId] : [buyerId, creatorId]
  );

  if (paidPurchase.rows.length) return true;

  // (B) Delivered request with this creator
  const deliveredReq = await db.query(
    `
    SELECT 1
      FROM custom_requests cr
     WHERE cr.buyer_id   = $1
       AND cr.creator_id = $2
       AND cr.status     = 'delivered'
     LIMIT 1
    `,
    [buyerId, creatorId]
  );
  if (deliveredReq.rows.length) return true;

  // (C) Active membership with access now
  const activeMember = await db.query(
    `
    SELECT 1
      FROM memberships m
     WHERE m.buyer_id  = $1
       AND m.creator_id= $2
       AND m.status IN ('active','trialing')
       AND NOW() <= m.current_period_end
     LIMIT 1
    `,
    [buyerId, creatorId]
  );
  if (activeMember.rows.length) return true;

  return false;
}

function sanitizeRating(n) {
  const r = parseInt(n, 10);
  if (Number.isNaN(r) || r < 1 || r > 5) return null;
  return r;
}

// ---------- routes ----------

/**
 * POST /api/reviews
 * Body: { creator_id, rating (1-5), comment?, product_id? }
 * - Only logged-in users
 * - Cannot review yourself
 * - Must have eligibility (paid purchase / delivered request / active membership)
 * - If user already reviewed this creator, we update their existing review (MVP)
 */
router.post("/", requireAuth, async (req, res) => {
  const buyerId = req.user.id;
  const { creator_id, rating, comment, product_id } = req.body || {};
  const creatorId = parseInt(creator_id, 10);
  const productId = product_id ? parseInt(product_id, 10) : null;

  if (!creatorId) return res.status(400).json({ error: "creator_id is required" });
  const r = sanitizeRating(rating);
  if (!r) return res.status(400).json({ error: "rating must be an integer between 1 and 5" });
  if (creatorId === buyerId) return res.status(400).json({ error: "You cannot review yourself" });

  try {
    const eligible = await hasEligibility(buyerId, creatorId, productId || undefined);
    if (!eligible) return res.status(403).json({ error: "Not eligible to review this creator" });

    // If an existing review by this buyer for this creator exists, update it; else insert
    const { rows: existing } = await db.query(
      `SELECT id FROM reviews WHERE buyer_id=$1 AND creator_id=$2 LIMIT 1`,
      [buyerId, creatorId]
    );

    if (existing.length) {
      const { rows } = await db.query(
        `UPDATE reviews
            SET rating=$1,
                comment=$2,
                product_id=$3,
                updated_at=NOW()
          WHERE id=$4
          RETURNING *`,
        [r, comment ?? null, productId, existing[0].id]
      );
      return res.json({ review: rows[0], updated: true });
    } else {
      const { rows } = await db.query(
        `INSERT INTO reviews (product_id, creator_id, buyer_id, rating, comment, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         RETURNING *`,
        [productId, creatorId, buyerId, r, comment ?? null]
      );
      return res.status(201).json({ review: rows[0], created: true });
    }
  } catch (e) {
    console.error("create review error:", e);
    res.status(500).json({ error: "Failed to submit review" });
  }
});

/**
 * PATCH /api/reviews/:id
 * Body: { rating?, comment? }
 * - Only the author (buyer) can edit their review
 */
router.patch("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const buyerId = req.user.id;
  const r = req.body.rating != null ? sanitizeRating(req.body.rating) : null;
  const comment = req.body.comment ?? null;

  if (req.body.rating != null && !r) {
    return res.status(400).json({ error: "rating must be 1..5" });
  }

  try {
    const { rows: owned } = await db.query(
      `SELECT id FROM reviews WHERE id=$1 AND buyer_id=$2`,
      [id, buyerId]
    );
    if (!owned.length) return res.status(403).json({ error: "Not your review" });

    const { rows } = await db.query(
      `UPDATE reviews
          SET rating = COALESCE($1, rating),
              comment = COALESCE($2, comment),
              updated_at = NOW()
        WHERE id=$3
        RETURNING *`,
      [r, comment, id]
    );

    res.json({ review: rows[0] });
  } catch (e) {
    console.error("edit review error:", e);
    res.status(500).json({ error: "Failed to edit review" });
  }
});

/**
 * DELETE /api/reviews/:id
 * - The author or an admin can delete
 */
router.delete("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const userId = req.user.id;
  const isAdmin = req.user.role === "admin";

  try {
    const { rows: rev } = await db.query(
      `SELECT id, buyer_id FROM reviews WHERE id=$1`,
      [id]
    );
    if (!rev.length) return res.status(404).json({ error: "Review not found" });

    if (!isAdmin && rev[0].buyer_id !== userId) {
      return res.status(403).json({ error: "Not allowed" });
    }

    await db.query(`DELETE FROM reviews WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (e) {
    console.error("delete review error:", e);
    res.status(500).json({ error: "Failed to delete review" });
  }
});

/**
 * PUBLIC: list reviews for a creator (paginated)
 * GET /api/reviews/creator/:creatorId?limit=20&offset=0
 */
router.get("/creator/:creatorId", async (req, res) => {
  const creatorId = parseInt(req.params.creatorId, 10);
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

  try {
    const { rows } = await db.query(
      `SELECT r.*, u.username AS buyer_username
         FROM reviews r
         JOIN users u ON u.id = r.buyer_id
        WHERE r.creator_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3`,
      [creatorId, limit, offset]
    );

    // also return a quick summary
    const { rows: summary } = await db.query(
      `SELECT
          COUNT(*)::int                         AS total,
          COALESCE(AVG(rating),0)::numeric(3,2) AS average,
          COALESCE(SUM(CASE WHEN rating=5 THEN 1 ELSE 0 END),0)::int AS star5,
          COALESCE(SUM(CASE WHEN rating=4 THEN 1 ELSE 0 END),0)::int AS star4,
          COALESCE(SUM(CASE WHEN rating=3 THEN 1 ELSE 0 END),0)::int AS star3,
          COALESCE(SUM(CASE WHEN rating=2 THEN 1 ELSE 0 END),0)::int AS star2,
          COALESCE(SUM(CASE WHEN rating=1 THEN 1 ELSE 0 END),0)::int AS star1
        FROM reviews
       WHERE creator_id=$1`,
      [creatorId]
    );

    res.json({ reviews: rows, summary: summary[0] });
  } catch (e) {
    console.error("list reviews error:", e);
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

/**
 * PUBLIC: review summary only (avg + counts)
 * GET /api/reviews/summary/:creatorId
 */
router.get("/summary/:creatorId", async (req, res) => {
  const creatorId = parseInt(req.params.creatorId, 10);
  try {
    const { rows } = await db.query(
      `SELECT
          COUNT(*)::int                         AS total,
          COALESCE(AVG(rating),0)::numeric(3,2) AS average,
          COALESCE(SUM(CASE WHEN rating=5 THEN 1 ELSE 0 END),0)::int AS star5,
          COALESCE(SUM(CASE WHEN rating=4 THEN 1 ELSE 0 END),0)::int AS star4,
          COALESCE(SUM(CASE WHEN rating=3 THEN 1 ELSE 0 END),0)::int AS star3,
          COALESCE(SUM(CASE WHEN rating=2 THEN 1 ELSE 0 END),0)::int AS star2,
          COALESCE(SUM(CASE WHEN rating=1 THEN 1 ELSE 0 END),0)::int AS star1
        FROM reviews
       WHERE creator_id=$1`,
      [creatorId]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error("summary error:", e);
    res.status(500).json({ error: "Failed to fetch review summary" });
  }
});

module.exports = router;