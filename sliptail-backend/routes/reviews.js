// routes/reviews.js
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

/* ------------------------ schema helpers ------------------------ */
async function hasTable(table) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name=$1
     LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

async function hasColumn(table, column) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

function sanitizeRating(n) {
  const r = parseInt(String(n), 10);
  if (!Number.isFinite(r) || r < 1 || r > 5) return null;
  return r;
}

/* ------------------------ eligibility ------------------------ */
/**
 * Checks if a buyer can review a creator (optionally tied to a specific product).
 * It is schema-aware and will skip checks if a table/column doesn't exist.
 */
async function hasEligibility(buyerId, creatorId, productId) {
  // (A) Paid purchase of this creator's product (optionally same product)
  if (await hasTable("orders")) {
    const ordersHasBuyer = await hasColumn("orders", "buyer_id");
    const ordersHasUser = await hasColumn("orders", "user_id");
    const buyerCol = ordersHasBuyer ? "o.buyer_id" : (ordersHasUser ? "o.user_id" : null);

    if (buyerCol) {
      const statusList = ["paid", "completed", "succeeded", "success"];
      const sql = `
        SELECT 1
          FROM orders o
          JOIN products p ON p.id = o.product_id
         WHERE ${buyerCol} = $1
           AND p.user_id    = $2
           AND o.status     = ANY($3::text[])
           ${productId ? "AND p.id = $4" : ""}
         LIMIT 1
      `;
      const params = productId ? [buyerId, creatorId, statusList, productId] : [buyerId, creatorId, statusList];
      const paidPurchase = await db.query(sql, params);
      if (paidPurchase.rows.length) return true;
    }
  }

  // (B) Delivered request with this creator
  if (await hasTable("custom_requests")) {
    const crHasBuyer = await hasColumn("custom_requests", "buyer_id");
    const buyerColCR = crHasBuyer ? "buyer_id" : "user_id";
    const statusListCR = ["delivered", "complete", "completed"];

    const deliveredReq = await db.query(
      `
      SELECT 1
        FROM custom_requests
       WHERE ${buyerColCR} = $1
         AND creator_id    = $2
         AND status        = ANY($3::text[])
       LIMIT 1
      `,
      [buyerId, creatorId, statusListCR]
    );
    if (deliveredReq.rows.length) return true;
  }

  // (C) Active membership with access now
  if (await hasTable("memberships")) {
    const memHasUser = await hasColumn("memberships", "user_id");
    const memHasProduct = await hasColumn("memberships", "product_id");
    const memHasCreator = await hasColumn("memberships", "creator_id");

    const statusListM = ["active", "trialing"];

    // Path 1: direct creator_id on memberships
    if (memHasUser && memHasCreator) {
      const hasBuyer = await hasColumn("memberships", "buyer_id");
      const buyerColM = hasBuyer ? "m.buyer_id" : "m.user_id";
      const activeMemberDirect = await db.query(
        `
        SELECT 1
          FROM memberships m
         WHERE ${buyerColM} = $1
           AND m.creator_id = $2
           AND m.status     = ANY($3::text[])
         LIMIT 1
        `,
        [buyerId, creatorId, statusListM]
      );
      if (activeMemberDirect.rows.length) return true;
    }

    // Path 2: infer creator via product owner
    if (memHasUser && memHasProduct) {
      const hasBuyer = await hasColumn("memberships", "buyer_id");
      const buyerColM = hasBuyer ? "m.buyer_id" : "m.user_id";
      const activeMemberViaProduct = await db.query(
        `
        SELECT 1
          FROM memberships m
          JOIN products p ON p.id = m.product_id
         WHERE ${buyerColM} = $1
           AND p.user_id    = $2
           AND m.status     = ANY($3::text[])
         LIMIT 1
        `,
        [buyerId, creatorId, statusListM]
      );
      if (activeMemberViaProduct.rows.length) return true;
    }
  }

  return false;
}

/* ------------------------ routes ------------------------ */

/**
 * POST /api/reviews
 * Body: { creator_id, rating (1-5), comment?, product_id? }
 * - Only logged-in users
 * - Cannot review yourself
 * - Must have eligibility (paid purchase / delivered request / active membership)
 * - Upsert rule:
 *   * If product_id provided → one review per (buyer_id, product_id) (replace on re-submit)
 *   * Else fall back to one review per (buyer_id, creator_id)
 */
router.post("/", requireAuth, async (req, res) => {
  const buyerId = req.user.id;
  const { creator_id, rating, comment, product_id } = req.body || {};

  const creatorId = parseInt(String(creator_id), 10);
  const productId = product_id != null ? parseInt(String(product_id), 10) : null;

  if (!Number.isFinite(creatorId)) return res.status(400).json({ error: "creator_id is required" });

  const r = sanitizeRating(rating);
  if (!r) return res.status(400).json({ error: "rating must be an integer between 1 and 5" });

  if (String(creatorId) === String(buyerId)) {
    return res.status(400).json({ error: "You cannot review yourself" });
  }

  try {
    const eligible = await hasEligibility(buyerId, creatorId, Number.isFinite(productId) ? productId : null);
    if (!eligible) return res.status(403).json({ error: "Not eligible to review this creator" });

    // Upsert by (buyer_id, product_id) if product specified; else by (buyer_id, creator_id)
    let existing;
    if (Number.isFinite(productId)) {
      ({ rows: existing } = await db.query(
        `SELECT id FROM reviews WHERE buyer_id=$1 AND product_id=$2 LIMIT 1`,
        [buyerId, productId]
      ));
    } else {
      ({ rows: existing } = await db.query(
        `SELECT id FROM reviews WHERE buyer_id=$1 AND creator_id=$2 LIMIT 1`,
        [buyerId, creatorId]
      ));
    }

    if (existing.length) {
      // only include updated_at if the column exists
      const haveUpdatedAt = await hasColumn("reviews", "updated_at");
      const sets = ["rating=$1", "comment=$2"];
      // keep/migrate product_id only when provided
      if (Number.isFinite(productId)) sets.push("product_id=$3");
      if (haveUpdatedAt) sets.push("updated_at=NOW()");

      const params = [
        r,
        typeof comment === "string" ? comment.trim() : null,
      ];
      if (Number.isFinite(productId)) params.push(productId);
      params.push(existing[0].id);

      const { rows } = await db.query(
        `UPDATE reviews
            SET ${sets.join(", ")}
          WHERE id=$${params.length}
          RETURNING *`,
        params
      );
      return res.json({ review: rows[0], updated: true });
    }

    const { rows } = await db.query(
      `INSERT INTO reviews (product_id, creator_id, buyer_id, rating, comment, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       RETURNING *`,
      [Number.isFinite(productId) ? productId : null, creatorId, buyerId, r, typeof comment === "string" ? comment.trim() : null]
    );
    return res.status(201).json({ review: rows[0], created: true });
  } catch (e) {
    console.error("create review error:", e?.message || e);
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
  const comment = typeof req.body.comment === "string" ? req.body.comment.trim() : null;

  if (req.body.rating != null && !r) {
    return res.status(400).json({ error: "rating must be 1..5" });
  }

  try {
    const { rows: owned } = await db.query(
      `SELECT id FROM reviews WHERE id=$1 AND buyer_id=$2`,
      [id, buyerId]
    );
    if (!owned.length) return res.status(403).json({ error: "Not your review" });

    const haveUpdatedAt = await hasColumn("reviews", "updated_at");

    const sets = [];
    const vals = [];
    let i = 1;

    if (r != null) { sets.push(`rating=$${i++}`); vals.push(r); }
    if (comment !== null) { sets.push(`comment=$${i++}`); vals.push(comment); }
    if (haveUpdatedAt) { sets.push("updated_at=NOW()"); }

    if (!sets.length) return res.status(400).json({ error: "No changes" });

    vals.push(id);

    const { rows } = await db.query(
      `UPDATE reviews
          SET ${sets.join(", ")}
        WHERE id=$${i}
        RETURNING *`,
      vals
    );

    res.json({ review: rows[0] });
  } catch (e) {
    console.error("edit review error:", e?.message || e);
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

    if (!isAdmin && String(rev[0].buyer_id) !== String(userId)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    await db.query(`DELETE FROM reviews WHERE id=$1`, [id]);
    res.json({ success: true });
  } catch (e) {
    console.error("delete review error:", e?.message || e);
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
    console.error("list reviews error:", e?.message || e);
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
    console.error("summary error:", e?.message || e);
    res.status(500).json({ error: "Failed to fetch review summary" });
  }
});

module.exports = router;
