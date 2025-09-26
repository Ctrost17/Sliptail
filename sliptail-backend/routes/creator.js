const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { hasColumn } = require("./creators"); // reuse helper if exported, OR copy the hasColumn fn here

// Simple, fast status: creator if they have ANY product (or any active product)
router.get("/status", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await db.query(
      `SELECT
         EXISTS(SELECT 1 FROM products WHERE user_id=$1)       AS has_any,
         EXISTS(SELECT 1 FROM products WHERE user_id=$1 AND active=TRUE) AS has_active`,
      [userId]
    );
    const hasAny = rows[0]?.has_any === true || rows[0]?.has_any === "t";
    const hasActive = rows[0]?.has_active === true || rows[0]?.has_active === "t";
    // "active" means they’re a creator for nav purposes
    res.json({ active: hasAny || hasActive });
  } catch (e) {
    console.error("creator status error:", e);
    // Don’t break the UI — default to false
    res.status(200).json({ active: false });
  }
});

// POST /api/creator/setup
router.post("/setup", requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    // Do we already have a creator profile?
    const existing = await db.query(
      `SELECT user_id, display_name, bio, profile_image,
              COALESCE(is_profile_complete,FALSE) AS is_profile_complete,
              COALESCE(is_active,FALSE)           AS is_active
         FROM creator_profiles
        WHERE user_id=$1
        LIMIT 1`,
      [userId]
    );

    if (existing.rows[0]) {
      // also include categories + gallery for the UI
      const { rows: photos } = await db.query(
        `SELECT url, position FROM creator_profile_photos WHERE user_id=$1 ORDER BY position ASC`,
        [userId]
      );
      const gallery = photos.map(p => p.url).slice(0, 4);

      const { rows: catsRows } = await db.query(
        `SELECT c.name
           FROM creator_categories cc
           JOIN categories c ON c.id = cc.category_id
          WHERE cc.creator_id=$1
          ORDER BY c.name ASC`,
        [userId]
      );

      return res.status(200).json({
        ok: true,
        creator: {
          user_id: userId,
          display_name: existing.rows[0].display_name || null,
          bio: existing.rows[0].bio || null,
          profile_image: existing.rows[0].profile_image || null,
          is_profile_complete: !!existing.rows[0].is_profile_complete,
          is_active: !!existing.rows[0].is_active,
          gallery,
          categories: catsRows.map(c => c.name),
        },
      });
    }

    // Insert a minimal shell profile (idempotent “setup”)
    await db.query(
      `INSERT INTO creator_profiles (user_id, display_name, bio, profile_image, is_profile_complete, is_active, created_at, updated_at)
       VALUES ($1, NULL, NULL, NULL, FALSE, FALSE, NOW(), NOW())`,
      [userId]
    );

    return res.status(201).json({
      ok: true,
      creator: {
        user_id: userId,
        display_name: null,
        bio: null,
        profile_image: null,
        is_profile_complete: false,
        is_active: false,
        gallery: [],
        categories: [],
      },
    });
  } catch (e) {
  console.error("creator/setup error:", e); // 👈 Will show the real error in console
  return res.status(500).json({ error: "Failed to save profile", details: e.message });
  }
});

module.exports = router;