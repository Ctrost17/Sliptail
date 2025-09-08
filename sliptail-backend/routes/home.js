const express = require("express");
const db = require("../db");

const router = express.Router();

/**
 * GET /api/home/featured
 * - Returns a list of featured creators with profile summary + categories + a few products
 * Query: ?limit=12
 */
router.get("/featured", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "12", 10), 50);

  try {
    // Get featured profiles
    const { rows: profiles } = await db.query(
      `SELECT cp.user_id AS creator_id,
              cp.display_name,
              cp.bio,
              cp.profile_image,
              cp.gallery,
              COALESCE(AVG(r.rating),0)::numeric(3,2) AS average_rating,
              COUNT(DISTINCT p.id)::int               AS products_count
         FROM creator_profiles cp
         LEFT JOIN reviews r  ON r.creator_id = cp.user_id
         LEFT JOIN products p ON p.user_id    = cp.user_id
        WHERE cp.featured = TRUE
        GROUP BY cp.user_id, cp.display_name, cp.bio, cp.profile_image, cp.gallery
        ORDER BY cp.user_id DESC
        LIMIT $1`,
      [limit]
    );

    // Get categories per creator
    const creatorIds = profiles.map(p => p.creator_id);
    let categoriesByCreator = {};
    if (creatorIds.length) {
      const { rows: cats } = await db.query(
        `SELECT cc.creator_id, c.id, c.name, c.slug
           FROM creator_categories cc
           JOIN categories c ON c.id = cc.category_id
          WHERE cc.creator_id = ANY($1::int[])`,
        [creatorIds]
      );
      for (const row of cats) {
        categoriesByCreator[row.creator_id] = categoriesByCreator[row.creator_id] || [];
        categoriesByCreator[row.creator_id].push({ id: row.id, name: row.name, slug: row.slug });
      }
    }

    // Grab up to 4 products per creator (simple preview)
    let productsByCreator = {};
    if (creatorIds.length) {
      const { rows: prods } = await db.query(
        `SELECT p.user_id AS creator_id, p.id, p.title, p.product_type, p.price
           FROM (
                SELECT *,
                       ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
                  FROM products
           ) p
          WHERE p.user_id = ANY($1::int[])
            AND p.rn <= 4`,
        [creatorIds]
      );
      for (const row of prods) {
        productsByCreator[row.creator_id] = productsByCreator[row.creator_id] || [];
        productsByCreator[row.creator_id].push(row);
      }
    }

    // Assemble payload
    const out = profiles.map(p => ({
      creator_id: p.creator_id,
      display_name: p.display_name,
      bio: p.bio,
      profile_image: p.profile_image,
      gallery: typeof p.gallery === "string" ? JSON.parse(p.gallery) : p.gallery,
      average_rating: p.average_rating,
      products_count: p.products_count,
      categories: categoriesByCreator[p.creator_id] || [],
      products_preview: productsByCreator[p.creator_id] || []
    }));

    res.json({ featured: out });
  } catch (e) {
    console.error("featured creators error:", e);
    res.status(500).json({ error: "Failed to fetch featured creators" });
  }
});

module.exports = router;