// server/routes/creator.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

/* ------------------------------- helpers ------------------------------- */

// Return { exists: boolean, nullable: boolean } for a column
async function getColumnInfo(table, column) {
  const { rows } = await db.query(
    `SELECT is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2
      LIMIT 1`,
    [table, column]
  );
  if (!rows.length) return { exists: false, nullable: true };
  return { exists: true, nullable: rows[0].is_nullable === "YES" };
}

// Build a shell creator_profiles row in a schema-safe way (idempotent)
async function ensureCreatorProfileShell(userId) {
  const colsInfo = {};
  // Columns we may want to set if present
  const candidates = [
    "display_name",
    "bio",
    "profile_image",
    "is_profile_complete",
    "is_active",
    "created_at",
    "updated_at",
    "is_featured",
    "featured",
  ];
  // eslint-disable-next-line no-restricted-syntax
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    colsInfo[c] = await getColumnInfo("creator_profiles", c).catch(() => ({ exists: false, nullable: true }));
  }

  const cols = ["user_id"];
  const vals = ["$1"];
  const params = [userId];

  // Use '' if NOT NULL for text columns, else NULL (safe starter)
  if (colsInfo.display_name.exists) {
    cols.push("display_name");
    vals.push(colsInfo.display_name.nullable ? "NULL" : "''");
  }
  if (colsInfo.bio.exists) {
    cols.push("bio");
    vals.push(colsInfo.bio.nullable ? "NULL" : "''");
  }
  if (colsInfo.profile_image.exists) {
    cols.push("profile_image");
    vals.push("NULL");
  }
  if (colsInfo.is_profile_complete.exists) {
    cols.push("is_profile_complete");
    vals.push("FALSE");
  }
  if (colsInfo.is_active.exists) {
    cols.push("is_active");
    vals.push("FALSE");
  }
  if (colsInfo.created_at.exists) {
    cols.push("created_at");
    vals.push("NOW()");
  }
  if (colsInfo.updated_at.exists) {
    cols.push("updated_at");
    vals.push("NOW()");
  }
  // support whichever featured column exists
  if (colsInfo.is_featured.exists) {
    cols.push("is_featured");
    vals.push("FALSE");
  } else if (colsInfo.featured.exists) {
    cols.push("featured");
    vals.push("FALSE");
  }

  const sql = `
    INSERT INTO creator_profiles (${cols.join(",")})
    SELECT ${vals.join(",")}
    WHERE NOT EXISTS (SELECT 1 FROM creator_profiles WHERE user_id=$1)
  `;
  await db.query(sql, params);
}

/* ------------------------------- routes -------------------------------- */

// Simple, fast status: creator if they have ANY product (or any active product)
router.get("/status", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await db.query(
      `SELECT
         EXISTS(SELECT 1 FROM products WHERE user_id=$1)                       AS has_any,
         EXISTS(SELECT 1 FROM products WHERE user_id=$1 AND active=TRUE)       AS has_active`,
      [userId]
    );
    const hasAny = rows[0]?.has_any === true || rows[0]?.has_any === "t";
    const hasActive = rows[0]?.has_active === true || rows[0]?.has_active === "t";
    res.json({ active: hasAny || hasActive });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("creator status error:", e);
    // Don’t break the UI — default to false
    res.status(200).json({ active: false });
  }
});

// POST /api/creator/setup  → ensure a shell row exists and return current state
router.post("/setup", requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    // If a row already exists, just return it (with gallery + categories)
    const existing = await db.query(
      `SELECT user_id, display_name, bio, profile_image,
              COALESCE(is_profile_complete,FALSE) AS is_profile_complete,
              COALESCE(is_active,FALSE)           AS is_active
         FROM creator_profiles
        WHERE user_id=$1
        LIMIT 1`,
      [userId]
    );

    if (!existing.rows[0]) {
      // Create a schema-safe blank row, idempotently
      await ensureCreatorProfileShell(userId);
      // Re-query so we can return what actually exists in this schema
      const recheck = await db.query(
        `SELECT user_id, display_name, bio, profile_image,
                COALESCE(is_profile_complete,FALSE) AS is_profile_complete,
                COALESCE(is_active,FALSE)           AS is_active
           FROM creator_profiles
          WHERE user_id=$1
          LIMIT 1`,
        [userId]
      );
      existing.rows[0] = recheck.rows[0] || null;
    }

    // Now include gallery + categories for the UI
    const { rows: photos } = await db.query(
      `SELECT url, position FROM creator_profile_photos WHERE user_id=$1 ORDER BY position ASC`,
      [userId]
    );
    const gallery = photos.map((p) => p.url).slice(0, 4);

    const { rows: catsRows } = await db.query(
      `SELECT c.name
         FROM creator_categories cc
         JOIN categories c ON c.id = cc.category_id
        WHERE cc.creator_id=$1
        ORDER BY c.name ASC`,
      [userId]
    );

    return res.status(existing.rows[0] ? 200 : 201).json({
      ok: true,
      creator: {
        user_id: userId,
        display_name: existing.rows[0]?.display_name ?? null,
        bio: existing.rows[0]?.bio ?? null,
        profile_image: existing.rows[0]?.profile_image ?? null,
        is_profile_complete: !!existing.rows[0]?.is_profile_complete,
        is_active: !!existing.rows[0]?.is_active,
        gallery,
        categories: catsRows.map((c) => c.name),
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("creator/setup error:", e);
    return res.status(500).json({ error: "Failed to save profile", details: e.message });
  }
});

module.exports = router;
