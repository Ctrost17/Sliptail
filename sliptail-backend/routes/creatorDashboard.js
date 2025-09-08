// routes/creatorDashboard.js
const express = require("express");
const db = require("../db");
const { requireAuth, requireCreator } = require("../middleware/auth");

const router = express.Router();

/**
 * GET /api/creator/dashboard/summary
 * Fast counters for the creator's dashboard.
 *
 * Returns:
 * {
 *   products_count,
 *   sales_count,
 *   sales_gross_cents,
 *   sales_last_30d_cents,
 *   requests_pending_count,
 *   requests_delivered_7d_count,
 *   members_active_count,
 *   reviews_avg,
 *   reviews_count
 * }
 */
router.get("/summary", requireAuth, requireCreator, async (req, res) => {
  const creatorId = req.user.id;

  try {
    // products created by me
    const { rows: products } = await db.query(
      `SELECT COUNT(*)::int AS products_count
         FROM products
        WHERE user_id = $1`,
      [creatorId]
    );

    // one-time purchase sales (orders join my products)
    const { rows: sales } = await db.query(
      `SELECT
         COUNT(o.id)::int                       AS sales_count,
         COALESCE(SUM(o.amount),0)::bigint      AS sales_gross_cents,
         COALESCE(SUM(CASE WHEN o.created_at >= NOW() - INTERVAL '30 days' THEN o.amount ELSE 0 END),0)::bigint AS sales_last_30d_cents
       FROM orders o
       JOIN products p ON p.id = o.product_id
      WHERE p.user_id = $1
        AND o.status = 'paid'`,
      [creatorId]
    );

    // requests: how many are pending for me; how many delivered in last 7 days
    const { rows: reqs } = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN cr.status = 'pending' THEN 1 ELSE 0 END),0)::int AS requests_pending_count,
         COALESCE(SUM(CASE WHEN cr.status = 'delivered' AND cr.created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END),0)::int AS requests_delivered_7d_count
       FROM custom_requests cr
      WHERE cr.creator_id = $1`,
      [creatorId]
    );

    // active memberships (buyer has access now)
    const { rows: members } = await db.query(
      `SELECT COUNT(*)::int AS members_active_count
         FROM memberships m
        WHERE m.creator_id = $1
          AND m.status IN ('active','trialing')
          AND NOW() <= m.current_period_end`,
      [creatorId]
    );

    // reviews: avg + count for me
    const { rows: reviews } = await db.query(
      `SELECT
         COALESCE(AVG(r.rating), 0)::numeric(3,2) AS reviews_avg,
         COUNT(r.id)::int                          AS reviews_count
       FROM reviews r
      WHERE r.creator_id = $1`,
      [creatorId]
    );

    res.json({
      ...products[0],
      ...sales[0],
      ...reqs[0],
      ...members[0],
      ...reviews[0],
    });
  } catch (e) {
    console.error("creator summary error:", e);
    res.status(500).json({ error: "Failed to fetch creator summary" });
  }
});

/**
 * GET /api/creator/dashboard/earnings?range=30d
 * Daily earnings (paid orders of my products) for a simple chart.
 * range supports '7d' | '30d' | '90d' | '365d' (default 30d)
 */
router.get("/earnings", requireAuth, requireCreator, async (req, res) => {
  const creatorId = req.user.id;
  const range = (req.query.range || "30d").toLowerCase();
  const map = { "7d": "7 days", "30d": "30 days", "90d": "90 days", "365d": "365 days" };
  const interval = map[range] || map["30d"];

  try {
    // group by day in server timezone; sum order amounts for PAID orders on my products
    const { rows } = await db.query(
      `SELECT
         to_char(date_trunc('day', o.created_at), 'YYYY-MM-DD') AS day,
         COALESCE(SUM(o.amount),0)::bigint AS amount_cents
       FROM orders o
       JOIN products p ON p.id = o.product_id
      WHERE p.user_id = $1
        AND o.status = 'paid'
        AND o.created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY 1
      ORDER BY 1`,
      [creatorId]
    );

    res.json({ range, points: rows });
  } catch (e) {
    console.error("creator earnings error:", e);
    res.status(500).json({ error: "Failed to fetch earnings" });
  }
});

module.exports = router;