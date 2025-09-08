const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

/** Simple role guard (JWT already has role) */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

// Apply guards to all admin routes
router.use(requireAuth, requireAdmin);

/* ------------------------- USERS: list / search ------------------------- */
/**
 * GET /api/admin/users?query=&limit=20&offset=0&only_active=true
 * - query matches email/username (ILIKE)
 */
router.get("/users", async (req, res) => {
  const q = (req.query.query || "").trim();
  const onlyActive = req.query.only_active === "true";
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

  const conds = [];
  const params = [];
  if (q) {
    params.push(`%${q}%`, `%${q}%`);
    conds.push(`(email ILIKE $${params.length - 1} OR COALESCE(username,'') ILIKE $${params.length})`);
  }
  if (onlyActive) {
    params.push(true);
    conds.push(`is_active = $${params.length}`);
  }
  params.push(limit, offset);

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const sql = `
    SELECT id, email, username, role, is_active, email_verified_at, created_at
      FROM users
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const { rows } = await db.query(sql, params);
  res.json({ users: rows });
});

/* ----------------------- USERS: deactivate/reactivate ------------------- */
/** POST /api/admin/users/:id/deactivate */
router.post("/users/:id/deactivate", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query(
    `UPDATE users SET is_active=false WHERE id=$1 RETURNING id, is_active`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: "User not found" });
  res.json({ success: true, user: rows[0] });
});

/** POST /api/admin/users/:id/reactivate */
router.post("/users/:id/reactivate", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query(
    `UPDATE users SET is_active=true WHERE id=$1 RETURNING id, is_active`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: "User not found" });
  res.json({ success: true, user: rows[0] });
});

/* --------------------------- REVIEWS: moderation ------------------------ */
/** GET /api/admin/reviews?creator_id=&product_id=&include_hidden=false */
router.get("/reviews", async (req, res) => {
  const { creator_id, product_id } = req.query;
  const includeHidden = req.query.include_hidden === "true";
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

  const conds = [];
  const params = [];
  if (creator_id) { params.push(parseInt(creator_id, 10)); conds.push(`r.creator_id = $${params.length}`); }
  if (product_id) { params.push(parseInt(product_id, 10)); conds.push(`r.product_id = $${params.length}`); }
  if (!includeHidden) conds.push(`r.hidden = false`);

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(limit, offset);

  const { rows } = await db.query(
    `SELECT r.id, r.product_id, r.creator_id, r.buyer_id, r.rating, r.comment, r.hidden, r.created_at
       FROM reviews r
      ${where}
      ORDER BY r.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ reviews: rows });
});

/** POST /api/admin/reviews/:id/hide */
router.post("/reviews/:id/hide", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query(
    `UPDATE reviews SET hidden=true WHERE id=$1 RETURNING id, hidden`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: "Review not found" });
  res.json({ success: true, review: rows[0] });
});

/** POST /api/admin/reviews/:id/unhide */
router.post("/reviews/:id/unhide", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query(
    `UPDATE reviews SET hidden=false WHERE id=$1 RETURNING id, hidden`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: "Review not found" });
  res.json({ success: true, review: rows[0] });
});

/** DELETE /api/admin/reviews/:id */
router.delete("/reviews/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query(
    `DELETE FROM reviews WHERE id=$1 RETURNING id`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: "Review not found" });
  res.json({ success: true, id });
});

/* ----------------------------- CATEGORIES CRUD -------------------------- */
/** GET /api/admin/categories */
router.get("/categories", async (_req, res) => {
  const { rows } = await db.query(
    `SELECT id, name, slug, created_at FROM categories ORDER BY name ASC`
  );
  res.json({ categories: rows });
});

/** POST /api/admin/categories { name, slug? } */
router.post("/categories", async (req, res) => {
  const { name, slug } = req.body || {};
  if (!name) return res.status(400).json({ error: "name required" });
  const { rows } = await db.query(
    `INSERT INTO categories (name, slug) VALUES ($1, COALESCE($2, NULL))
     ON CONFLICT (slug) DO NOTHING
     RETURNING *`,
    [name, slug || null]
  );
  res.status(201).json({ category: rows[0] || null });
});

/** PUT /api/admin/categories/:id { name?, slug? } */
router.put("/categories/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, slug } = req.body || {};
  const { rows } = await db.query(
    `UPDATE categories
        SET name = COALESCE($1, name),
            slug = COALESCE($2, slug)
      WHERE id=$3
      RETURNING *`,
    [name ?? null, slug ?? null, id]
  );
  if (!rows.length) return res.status(404).json({ error: "Category not found" });
  res.json({ category: rows[0] });
});

/** DELETE /api/admin/categories/:id */
router.delete("/categories/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query(
    `DELETE FROM categories WHERE id=$1 RETURNING id`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: "Category not found" });
  res.json({ success: true, id });
});

/* ------------------------ FEATURE / UNFEATURE CREATORS ------------------ */
/** POST /api/admin/creators/:id/feature */
router.post("/creators/:id/feature", async (req, res) => {
  const creatorId = parseInt(req.params.id, 10);
  const { rows } = await db.query(
    `UPDATE creator_profiles SET is_featured=true WHERE user_id=$1 RETURNING user_id, is_featured`,
    [creatorId]
  );
  if (!rows.length) return res.status(404).json({ error: "Creator profile not found" });
  res.json({ success: true, profile: rows[0] });
});

/** POST /api/admin/creators/:id/unfeature */
router.post("/creators/:id/unfeature", async (req, res) => {
  const creatorId = parseInt(req.params.id, 10);
  const { rows } = await db.query(
    `UPDATE creator_profiles SET is_featured=false WHERE user_id=$1 RETURNING user_id, is_featured`,
    [creatorId]
  );
  if (!rows.length) return res.status(404).json({ error: "Creator profile not found" });
  res.json({ success: true, profile: rows[0] });
});

/* -------------------------------- METRICS -------------------------------- */
/**
 * GET /api/admin/metrics
 * - total_revenue: sum of paid orders (supports amount or amount_cents)
 * - active_members: memberships active/trialing and not expired
 * - active_creators: distinct creators with at least one active product
 * - total_users, total_creators, total_products
 */
router.get("/metrics", async (_req, res) => {
  const sql = `
    SELECT
      /* total revenue - supports either amount (decimal) or amount_cents (int) */
      COALESCE(
        (SELECT SUM(amount) FROM orders WHERE status='paid'),
        (SELECT SUM(amount_cents)/100.0 FROM orders WHERE status='paid')
      ) AS total_revenue,

      /* active members = active/trialing and not expired */
      (SELECT COUNT(*) FROM memberships
        WHERE status IN ('active','trialing')
          AND current_period_end >= NOW()) AS active_members,

      /* active creators = creators with at least one active product */
      (SELECT COUNT(DISTINCT p.user_id) FROM products p WHERE COALESCE(p.active,true)=true) AS active_creators,

      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM users WHERE role='creator') AS total_creators,
      (SELECT COUNT(*) FROM products) AS total_products
  `;
  const { rows } = await db.query(sql);
  res.json(rows[0]);
});

module.exports = router;