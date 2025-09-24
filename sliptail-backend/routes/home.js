// routes/home.js
const express = require("express");
const db = require("../db");

const router = express.Router();

const featuredExpr = "COALESCE(cp.is_featured, cp.featured, FALSE)";

// Optional helper: if you also want to gate by role/active/profile-complete, set these to true
const REQUIRE_ROLE_CREATOR = true;
const REQUIRE_PROFILE_ACTIVE = true;
const REQUIRE_PROFILE_COMPLETE = true;

/**
 * Internal query used by both endpoints below.
 * Note: We DO NOT require ≥1 active product here, so featured creators show immediately.
 */
async function queryFeatured(limit) {
  const whereConds = [
    `${featuredExpr} = TRUE`,
  ];
  if (REQUIRE_ROLE_CREATOR) whereConds.push(`u.role = 'creator'`);
  if (REQUIRE_PROFILE_ACTIVE) whereConds.push(`cp.is_active = TRUE`);
  if (REQUIRE_PROFILE_COMPLETE) whereConds.push(`cp.is_profile_complete = TRUE`);

  const whereSql = `WHERE ${whereConds.join(" AND ")}`;

  // Base profiles
  const { rows: profiles } = await db.query(
    `
    SELECT
      cp.user_id AS creator_id,
      cp.display_name,
      cp.bio,
      cp.profile_image,
      cp.gallery,
      ${featuredExpr} AS is_featured,
      COALESCE(AVG(r.rating),0)::numeric(3,2) AS average_rating,
      COUNT(DISTINCT p.id)::int               AS products_count
    FROM creator_profiles cp
    JOIN users u ON u.id = cp.user_id
    LEFT JOIN reviews  r ON r.creator_id = cp.user_id
    LEFT JOIN products p ON p.user_id    = cp.user_id AND p.active = TRUE
    ${whereSql}
    GROUP BY cp.user_id, cp.display_name, cp.bio, cp.profile_image, cp.gallery, ${featuredExpr}
    ORDER BY average_rating DESC NULLS LAST, products_count DESC, cp.display_name ASC
    LIMIT $1
    `,
    [limit]
  );

  if (!profiles.length) return [];

  const creatorIds = profiles.map((p) => p.creator_id);

  // Categories per creator
  let categoriesByCreator = {};
  if (creatorIds.length) {
    const { rows: cats } = await db.query(
      `
      SELECT cc.creator_id, c.id, c.name, c.slug
      FROM creator_ cc
      JOIN categories c ON c.id = cc.category_id
      WHERE cc.creator_id = ANY($1::int[])
      ORDER BY c.name ASC
      `,
      [creatorIds]
    );
    for (const row of cats) {
      categoriesByCreator[row.creator_id] ||= [];
      categoriesByCreator[row.creator_id].push({ id: row.id, name: row.name, slug: row.slug });
    }
  }

  // Up to 4 recent products per creator
  let productsByCreator = {};
  if (creatorIds.length) {
    const { rows: prods } = await db.query(
      `
      SELECT t.user_id AS creator_id, t.id, t.title, t.product_type, t.price
      FROM (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
        FROM products
        WHERE active = TRUE
      ) t
      WHERE t.user_id = ANY($1::int[]) AND t.rn <= 4
      `,
      [creatorIds]
    );
    for (const row of prods) {
      productsByCreator[row.creator_id] ||= [];
      productsByCreator[row.creator_id].push(row);
    }
  }

  // Assemble
  return profiles.map((p) => ({
    creator_id: p.creator_id,
    display_name: p.display_name,
    bio: p.bio,
    profile_image: p.profile_image,
    // gallery column may be JSON text or NULL; normalize to array
    gallery:
      Array.isArray(p.gallery)
        ? p.gallery
        : (typeof p.gallery === "string" ? safeParseJsonArray(p.gallery) : []),
    average_rating: p.average_rating,
    products_count: p.products_count,
    is_featured: !!p.is_featured,
    categories: categoriesByCreator[p.creator_id] || [],
    products_preview: productsByCreator[p.creator_id] || [],
  }));
}

function safeParseJsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Keep your original endpoint (shape = { featured: [...] })
 * GET /api/home/featured
 */
router.get("/featured", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "12", 10), 50);
  try {
    const featured = await queryFeatured(limit);
    return res.json({ featured });
  } catch (e) {
    console.error("home featured error:", e);
    return res.status(500).json({ error: "Failed to fetch featured creators" });
  }
});

/**
 * NEW alias that matches the homepage expectation (shape = { creators: [...] })
 * Mount this router at /api/home AND also add a pass-through in creators.js if you like.
 * GET /api/creators/featured  ->  { creators: [...] }
 */
router.get("/creators/featured", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "12", 10), 50);
  try {
    const creators = await queryFeatured(limit);
    return res.json({ creators });
  } catch (e) {
    console.error("home creators/featured error:", e);
    return res.status(500).json({ error: "Failed to fetch featured creators" });
  }
});

module.exports = router;
