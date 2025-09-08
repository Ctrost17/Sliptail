const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

/**
 * Public: list categories
 * - Default: active categories only
 * - With ?count=true: include creator counts (eligible creators only)
 */
router.get("/", async (req, res) => {
  const withCounts = String(req.query.count || "").toLowerCase() === "true";

  try {
    if (!withCounts) {
      // plain categories (current flow)
      const { rows } = await db.query(
        `SELECT id, name, slug
           FROM categories
          WHERE active = TRUE
          ORDER BY name ASC`
      );
      return res.json({ categories: rows });
    }

    // with creator counts
    const { rows } = await db.query(
      `
      SELECT
        c.id,
        c.name,
        c.slug,
        COUNT(DISTINCT cp.user_id)::int AS creators_count
      FROM categories c
      LEFT JOIN creator_categories cc ON cc.category_id = c.id
      LEFT JOIN creator_profiles cp    ON cp.user_id     = cc.creator_id
      LEFT JOIN users u                ON u.id           = cp.user_id
      LEFT JOIN products p             ON p.user_id      = cp.user_id AND p.active = TRUE
      WHERE c.active = TRUE
        AND (cp.user_id IS NULL
             OR (u.enabled = TRUE
                 AND u.role = 'creator'
                 AND cp.is_profile_complete = TRUE
                 AND cp.is_active = TRUE))
      GROUP BY c.id, c.name, c.slug
      ORDER BY c.name ASC
      `
    );
    res.json({ categories: rows });
  } catch (e) {
    console.error("list categories error:", e);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

/**
 * Admin: create category
 * Body: { name, slug }
 */
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const { name, slug } = req.body || {};
  try {
    const { rows } = await db.query(
      `INSERT INTO categories (name, slug, active)
       VALUES ($1, $2, TRUE)
       RETURNING *`,
      [name, slug]
    );
    res.status(201).json({ category: rows[0] });
  } catch (e) {
    console.error("create category error:", e);
    res.status(500).json({ error: "Failed to create category" });
  }
});

/**
 * Admin: update category (rename, toggle active)
 * Body: { name?, slug?, active? }
 */
router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, slug, active } = req.body || {};
  try {
    const { rows } = await db.query(
      `UPDATE categories
          SET name = COALESCE($1, name),
              slug = COALESCE($2, slug),
              active = COALESCE($3, active)
        WHERE id=$4
        RETURNING *`,
      [name ?? null, slug ?? null, typeof active === "boolean" ? active : null, id]
    );
    if (!rows.length) return res.status(404).json({ error: "Category not found" });
    res.json({ category: rows[0] });
  } catch (e) {
    console.error("update category error:", e);
    res.status(500).json({ error: "Failed to update category" });
  }
});

module.exports = router;