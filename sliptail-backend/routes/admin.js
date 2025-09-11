const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// All admin routes require auth + admin
router.use(requireAuth, requireAdmin);

/* ------------------------- helpers: tx + optional delete ---------------- */

async function withTx(run) {
  // Works with either a Pool (db.connect) or a simple { query } helper.
  if (typeof db.connect === "function") {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await run((q, p) => client.query(q, p));
      await client.query("COMMIT");
      return result;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      throw e;
    } finally {
      client.release();
    }
  } else {
    try {
      await db.query("BEGIN");
      const result = await run((q, p) => db.query(q, p));
      await db.query("COMMIT");
      return result;
    } catch (e) {
      try { await db.query("ROLLBACK"); } catch {}
      throw e;
    }
  }
}

/**
 * Run a DELETE that may reference a table/column your DB might not have.
 * - Skips cleanly if relation (42P01) or column (42703) is missing.
 * - Re-throws other errors.
 */
async function runOptional(queryFn, sql, params) {
  try {
    return await queryFn(sql, params);
  } catch (e) {
    // undefined_table OR undefined_column -> skip
    if (e && (e.code === "42P01" || e.code === "42703")) {
      console.warn("[hard-delete] skipped:", e.message);
      return { rows: [] };
    }
    throw e;
  }
}

/**
 * HARD DELETE a user and all related rows we know about.
 * Order matters when FKs exist without ON DELETE CASCADE.
 * Add/remove tables here as your schema evolves.
 */
async function hardDeleteUser(queryFn, userId) {
  // 1) BY PRODUCT ownership (delete child rows that point to products)
  await runOptional(queryFn,
    `DELETE FROM orders o USING products p
      WHERE o.product_id = p.id AND p.user_id = $1`,
    [userId]
  );
  await runOptional(queryFn,
    `DELETE FROM reviews r USING products p
      WHERE r.product_id = p.id AND p.user_id = $1`,
    [userId]
  );

  // 2) BY USER direct relationships
  await runOptional(queryFn, `DELETE FROM reviews WHERE buyer_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM reviews WHERE creator_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM memberships WHERE user_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM memberships WHERE creator_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM requests WHERE buyer_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM requests WHERE seller_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM notifications WHERE user_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM notifications WHERE actor_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM posts WHERE user_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM downloads WHERE user_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM downloads WHERE buyer_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM messages WHERE sender_id = $1 OR recipient_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM orders WHERE buyer_id = $1`, [userId]);

  // 3) Creator-specific joins & resources
  await runOptional(queryFn, `DELETE FROM creator_categories WHERE creator_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM products WHERE user_id = $1`, [userId]);
  await runOptional(queryFn, `DELETE FROM creator_profiles WHERE user_id = $1`, [userId]);

  // 4) Finally the user
  const deleted = await queryFn(`DELETE FROM users WHERE id = $1 RETURNING id`, [userId]);
  if (!deleted.rows.length) {
    throw Object.assign(new Error("User not found"), { statusCode: 404 });
  }
}

/* ------------------------- USERS: list / search ------------------------- */
/**
 * GET /api/admin/users?query=&limit=20&offset=0&only_active=true&role=ALL|ADMIN|CREATOR|USER
 * - query matches email/username (ILIKE)
 */
router.get("/users", async (req, res) => {
  try {
    const q = (req.query.query || "").trim();
    const onlyActive = req.query.only_active === "true";
    const role = String(req.query.role || "ALL").toLowerCase();
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
    if (["admin", "creator", "user"].includes(role)) {
      params.push(role);
      conds.push(`LOWER(role) = $${params.length}`);
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
  } catch (e) {
    console.error("admin GET /users error:", e);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

/* ----------------------- USERS: deactivate/reactivate ------------------- */
router.post("/users/:id/deactivate", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `UPDATE users SET is_active=false WHERE id=$1 RETURNING id, is_active`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user: rows[0] });
  } catch (e) {
    console.error("admin POST /users/:id/deactivate error:", e);
    res.status(500).json({ error: "Failed to deactivate user" });
  }
});

router.post("/users/:id/reactivate", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `UPDATE users SET is_active=true WHERE id=$1 RETURNING id, is_active`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user: rows[0] });
  } catch (e) {
    console.error("admin POST /users/:id/reactivate error:", e);
    res.status(500).json({ error: "Failed to reactivate user" });
  }
});

/* -------------------------- CREATORS: list & remove --------------------- */
/**
 * GET /api/admin/creators?query=&only_active=true&limit=20&offset=0
 * Lists creators with role + featured flags.
 */
router.get("/creators", async (req, res) => {
  try {
    const q = (req.query.query || "").trim();
    const onlyActive = req.query.only_active === "true";
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

    const conds = [`u.role = 'creator'`];
    const params = [];
    if (q) {
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      conds.push(
        `(u.email ILIKE $${params.length - 2} OR COALESCE(u.username,'') ILIKE $${params.length - 1} OR COALESCE(cp.display_name,'') ILIKE $${params.length})`
      );
    }
    if (onlyActive) {
      conds.push(`u.is_active = true AND cp.is_active = true`);
    }

    params.push(limit, offset);

    const where = `WHERE ${conds.join(" AND ")}`;
    const sql = `
      SELECT
        u.id,
        u.email,
        u.username,
        u.role,
        u.is_active AS user_active,
        cp.is_active AS creator_active,
        cp.featured,           -- NEW
        cp.is_featured,
        cp.display_name,
        cp.created_at,
        cp.updated_at
      FROM users u
      JOIN creator_profiles cp ON cp.user_id = u.id
      ${where}
      ORDER BY cp.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const { rows } = await db.query(sql, params);
    res.json({ creators: rows });
  } catch (e) {
    console.error("admin GET /creators error:", e);
    res.status(500).json({ error: "Failed to fetch creators" });
  }
});

/** DELETE /api/admin/creators/:id (hard delete creator + dependents) */
router.delete("/creators/:id", async (req, res) => {
  const creatorId = parseInt(req.params.id, 10);
  try {
    await withTx(async (q) => {
      await hardDeleteUser(q, creatorId);
    });
    res.json({ success: true, id: creatorId });
  } catch (e) {
    const status = e.statusCode || 500;
    console.error("admin DELETE /creators/:id error:", e);
    res.status(status).json({ error: e.message || "Failed to hard-delete creator" });
  }
});

/* ------------------------ FEATURE / UNFEATURE CREATORS ------------------ */
router.post("/creators/:id/feature", async (req, res) => {
  try {
    const creatorId = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `UPDATE creator_profiles
          SET featured = true, is_featured = true
        WHERE user_id = $1
        RETURNING user_id, featured, is_featured`,
      [creatorId]
    );
    if (!rows.length) return res.status(404).json({ error: "Creator profile not found" });
    res.json({ success: true, profile: rows[0] });
  } catch (e) {
    console.error("admin POST /creators/:id/feature error:", e);
    res.status(500).json({ error: "Failed to feature creator" });
  }
});

// PATCH alias to match the Step-3 spec (keeps the same flow)
router.patch("/creators/:id/feature", async (req, res) => {
  try {
    const creatorId = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `UPDATE creator_profiles
          SET featured = true, is_featured = true
        WHERE user_id = $1
        RETURNING user_id, featured, is_featured`,
      [creatorId]
    );
    if (!rows.length) return res.status(404).json({ error: "Creator profile not found" });
    res.json({ success: true, profile: rows[0] });
  } catch (e) {
    console.error("admin PATCH /creators/:id/feature error:", e);
    res.status(500).json({ error: "Failed to feature creator" });
  }
});

router.post("/creators/:id/unfeature", async (req, res) => {
  try {
    const creatorId = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `UPDATE creator_profiles
          SET featured = false, is_featured = false
        WHERE user_id = $1
        RETURNING user_id, featured, is_featured`,
      [creatorId]
    );
    if (!rows.length) return res.status(404).json({ error: "Creator profile not found" });
    res.json({ success: true, profile: rows[0] });
  } catch (e) {
    console.error("admin POST /creators/:id/unfeature error:", e);
    res.status(500).json({ error: "Failed to unfeature creator" });
  }
});

/* --------------------------- REVIEWS: moderation ------------------------ */
router.get("/reviews", async (req, res) => {
  try {
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
  } catch (e) {
    console.error("admin GET /reviews error:", e);
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

router.post("/reviews/:id/hide", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `UPDATE reviews SET hidden=true WHERE id=$1 RETURNING id, hidden`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Review not found" });
    res.json({ success: true, review: rows[0] });
  } catch (e) {
    console.error("admin POST /reviews/:id/hide error:", e);
    res.status(500).json({ error: "Failed to hide review" });
  }
});

router.post("/reviews/:id/unhide", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `UPDATE reviews SET hidden=false WHERE id=$1 RETURNING id, hidden`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Review not found" });
    res.json({ success: true, review: rows[0] });
  } catch (e) {
    console.error("admin POST /reviews/:id/unhide error:", e);
    res.status(500).json({ error: "Failed to unhide review" });
  }
});

router.delete("/reviews/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `DELETE FROM reviews WHERE id=$1 RETURNING id`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Review not found" });
    res.json({ success: true, id });
  } catch (e) {
    console.error("admin DELETE /reviews/:id error:", e);
    res.status(500).json({ error: "Failed to delete review" });
  }
});

/* ----------------------------- CATEGORIES CRUD -------------------------- */
router.get("/categories", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, slug, active, created_at FROM categories ORDER BY name ASC`
    );
    res.json({ categories: rows });
  } catch (e) {
    console.error("admin GET /categories error:", e);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

router.post("/categories", async (req, res) => {
  try {
    const { name, slug } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const { rows } = await db.query(
      `INSERT INTO categories (name, slug, active)
       VALUES ($1, COALESCE($2, NULL), TRUE)
       ON CONFLICT (slug) DO NOTHING
       RETURNING *`,
      [name, slug || null]
    );
    res.status(201).json({ category: rows[0] || null });
  } catch (e) {
    console.error("admin POST /categories error:", e);
    res.status(500).json({ error: "Failed to create category" });
  }
});

router.put("/categories/:id", async (req, res) => {
  try {
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
  } catch (e) {
    console.error("admin PUT /categories/:id error:", e);
    res.status(500).json({ error: "Failed to update category" });
  }
});

/** HARD DELETE category + join rows */
router.delete("/categories/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await withTx(async (q) => {
      await runOptional(q, `DELETE FROM creator_categories WHERE category_id=$1`, [id]);
      const del = await q(`DELETE FROM categories WHERE id=$1 RETURNING id`, [id]);
      if (!del.rows.length) throw Object.assign(new Error("Category not found"), { statusCode: 404 });
    });
    res.json({ success: true, id });
  } catch (e) {
    const status = e.statusCode || 500;
    console.error("admin DELETE /categories/:id error:", e);
    res.status(status).json({ error: e.message || "Failed to delete category" });
  }
});

/* -------------------------------- METRICS -------------------------------- */
router.get("/metrics", async (_req, res) => {
  try {
    const sql = `
      SELECT
        (SELECT COALESCE(SUM(amount_cents),0)/100.0 FROM orders WHERE status='paid') AS total_revenue,
        (SELECT COUNT(*) FROM memberships
          WHERE status IN ('active','trialing')
            AND current_period_end >= NOW()) AS active_members,
        (SELECT COUNT(DISTINCT p.user_id) FROM products p WHERE COALESCE(p.active,true)=true) AS active_creators,
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM users WHERE role='creator') AS total_creators,
        (SELECT COUNT(*) FROM products) AS total_products
    `;
    const { rows } = await db.query(sql);
    res.json(rows[0]);
  } catch (e) {
    console.error("admin GET /metrics error:", e);
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

module.exports = router;
