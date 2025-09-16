const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { recomputeCreatorActive } = require("../services/creatorStatus");
const jwt = require("jsonwebtoken");

// media upload deps
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const router = express.Router();

/* ------------------------------- PARAM GUARD ------------------------------ */
/** Skip any :creatorId route if the param isn’t a finite integer (prevents "/featured" from matching). */
router.param("creatorId", (req, res, next, val) => {
  const id = Number.parseInt(String(val), 10);
  if (!Number.isFinite(id)) return next("route");
  req.creatorId = id;
  return next();
});

/* -------------------------------- helpers -------------------------------- */

function toSafeUser(u) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    role: u.role,
    email_verified_at: u.email_verified_at,
    created_at: u.created_at,
  };
}
function issueJwtFromUserRow(u) {
  return jwt.sign(
    {
      id: u.id,
      email: u.email,
      role: u.role || "user",
      email_verified_at: u.email_verified_at,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// Build a public URL (relative path under /uploads) from an absolute file path.
function toPublicUrl(absPath) {
  const marker = `${path.sep}uploads${path.sep}`;
  const idx = absPath.lastIndexOf(marker);
  if (idx === -1) return null;
  const rel = absPath.slice(idx).replace(/\\/g, "/"); // => "/uploads/creators/..."
  // Ensure we DO NOT produce "//uploads/..."
  return rel.startsWith("/") ? rel : `/${rel}`;
}

// column-existence helper (so we can handle missing categories.slug, users.enabled)
async function hasColumn(table, column) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

// Build a safe users.enabled clause (no-op if column missing)
async function usersEnabledClause() {
  const has = await hasColumn("users", "enabled");
  return has ? "u.enabled = TRUE" : "TRUE";
}

/**
 * FEATURED support across schemas:
 * Some DBs have creator_profiles.is_featured; others have creator_profiles.featured.
 * Use a COALESCE in reads, and set whichever column exists in writes.
 */
const FEATURED_COLS = ["is_featured", "featured"];

async function getFeaturedColumnName() {
  for (const c of FEATURED_COLS) {
    // eslint-disable-next-line no-await-in-loop
    if (await hasColumn("creator_profiles", c)) return c;
  }
  // default to 'featured' (keeps prior behavior if neither was found — rare)
  return "featured";
}

// Reusable SQL expression for reading "is featured?"
const featuredExpr = "COALESCE(cp.is_featured, cp.featured, FALSE)";

/* --------------------------- media upload setup --------------------------- */

const creatorUploadRoot = path.join(__dirname, "..", "public", "uploads", "creators");
if (!fs.existsSync(creatorUploadRoot)) {
  fs.mkdirSync(creatorUploadRoot, { recursive: true });
}
const imageMimes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const creatorStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.user?.id || "unknown";
    const userDir = path.join(creatorUploadRoot, String(userId));
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const base = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cb(null, `${base}${ext || ".jpg"}`);
  },
});

const uploadCreatorMedia = multer({
  storage: creatorStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
  fileFilter: (req, file, cb) => {
    if (!imageMimes.has(file.mimetype)) return cb(new Error("Only image files are allowed"));
    cb(null, true);
  },
});

// Lightweight single-file uploader (reuse same storage & filter)
const uploadSingleImage = multer({
  storage: creatorStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!imageMimes.has(file.mimetype)) return cb(new Error("Only image files are allowed"));
    cb(null, true);
  },
});

/* --------------------------------- routes -------------------------------- */

/**
 * LEGACY: immediately set role=creator.
 */
router.post("/become", requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    await db.query("BEGIN");

    await db.query(
      `UPDATE users SET role='creator'
         WHERE id=$1 AND (role IS NULL OR role <> 'creator')`,
      [userId]
    );

    const { rows } = await db.query(`SELECT * FROM users WHERE id=$1 LIMIT 1`, [userId]);
    if (!rows.length) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "User not found" });
    }

    const user = rows[0];
    const token = issueJwtFromUserRow(user);
    await db.query("COMMIT");

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV !== "development",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
    });

    return res.json({ success: true, creator_id: userId, token, user: toSafeUser(user) });
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("become creator error:", e);
    return res.status(500).json({ error: "Failed to become a creator" });
  }
});

/**
 * Activate creator role only if truly ready.
 */
router.post("/activate", requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const status = await recomputeCreatorActive(db, userId);

    const missing = [];
    if (!status?.profileComplete) missing.push("Complete your profile");
    if (!status?.stripeConnected) missing.push("Connect your Stripe account");
    if (!status?.hasPublishedProduct) missing.push("Publish at least one product");

    if (missing.length) {
      return res.status(400).json({ success: false, missing });
    }

    await db.query("BEGIN");

    await db.query(
      `UPDATE users SET role='creator'
         WHERE id=$1 AND (role IS NULL OR role <> 'creator')`,
      [userId]
    );

    const { rows } = await db.query(`SELECT * FROM users WHERE id=$1 LIMIT 1`, [userId]);
    if (!rows.length) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "User not found" });
    }

    const user = rows[0];
    const token = issueJwtFromUserRow(user);

    await db.query("COMMIT");

    res.cookie("token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV !== "development",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/",
    });

    return res.json({ success: true, token, user: toSafeUser(user) });
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("activate error:", e);
    return res.status(500).json({ error: "Failed to activate creator" });
  }
});

/**
 * Upload my creator media (profile image + 4 gallery photos)
 */
router.post(
  "/me/media",
  requireAuth,
  uploadCreatorMedia.fields([
    { name: "profile_image", maxCount: 1 },
    { name: "gallery", maxCount: 4 },
  ]),
  async (req, res) => {
    const userId = req.user.id;

    try {
      const prof = req.files?.profile_image?.[0] || null;
      const gal = Array.isArray(req.files?.gallery) ? req.files.gallery : [];

      if (!prof) return res.status(400).json({ error: "profile_image is required" });
      if (gal.length !== 4) return res.status(400).json({ error: "Exactly 4 gallery photos are required" });

      const profilePublic = toPublicUrl(prof.path);
      const galleryPublic = gal.map((f) => toPublicUrl(f.path)).filter(Boolean);

      if (!profilePublic || galleryPublic.length !== 4) {
        return res.status(500).json({ error: "Failed to generate public URLs" });
      }

      await db.query("BEGIN");

      // INSERT/UPSERT profile row; set whichever featured column exists to FALSE on first insert
      const featCol = await getFeaturedColumnName();
      await db.query(
        `INSERT INTO creator_profiles (user_id, display_name, bio, profile_image, ${featCol}, created_at, updated_at)
         VALUES ($1, NULL, NULL, $2, FALSE, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET profile_image = EXCLUDED.profile_image,
               updated_at = NOW()`,
        [userId, profilePublic]
      );

      await db.query(`DELETE FROM creator_profile_photos WHERE user_id=$1`, [userId]);
      const values = galleryPublic.map((_, i) => `($1,$${i + 2},$${i + 6})`).join(",");
      const params = [userId, ...galleryPublic, ...[1, 2, 3, 4]];
      await db.query(
        `INSERT INTO creator_profile_photos (user_id, url, position) VALUES ${values}`,
        params
      );

      await db.query("COMMIT");

      res.json({ profile_image: profilePublic, gallery: galleryPublic });
    } catch (e) {
      try { await db.query("ROLLBACK"); } catch {}
      console.error("creator media upload error:", e);
      res.status(500).json({ error: "Failed to upload creator media" });
    }
  }
);

/**
 * Upsert MY creator profile (multipart or JSON)
 */
router.post(
  "/me",
  requireAuth,
  (req, res, next) => {
    const ct = req.headers["content-type"] || "";
    if (ct.startsWith("multipart/form-data")) {
      return uploadCreatorMedia.fields([
        { name: "profile_image", maxCount: 1 },
        { name: "gallery", maxCount: 4 },
      ])(req, res, next);
    }
    return next();
  },
  async (req, res) => {
    const userId = req.user.id;
    const isMultipart = !!req.files;

    try {
      let display_name = (req.body?.display_name || "").trim();
      let bio = (req.body?.bio || "").trim();

      if (!display_name || !bio) {
        return res.status(400).json({ error: "display_name and bio are required" });
      }

      let profile_image_url = null;
      let gallery_urls = null;

      if (isMultipart) {
        const prof = req.files?.profile_image?.[0] || null;
        const gal = Array.isArray(req.files?.gallery) ? req.files.gallery : [];

        if (!prof) return res.status(400).json({ error: "profile_image is required" });
        if (gal.length !== 4) return res.status(400).json({ error: "Exactly 4 gallery photos are required" });

        profile_image_url = toPublicUrl(prof.path);
        gallery_urls = gal.map((f) => toPublicUrl(f.path)).filter(Boolean);

        if (!profile_image_url || gallery_urls.length !== 4) {
          return res.status(500).json({ error: "Failed to generate public URLs" });
        }
      } else {
        profile_image_url = req.body?.profile_image || null;
        const gallery = Array.isArray(req.body?.gallery) ? req.body.gallery : null;
        gallery_urls = gallery ? gallery.slice(0, 4).filter(Boolean) : null;
      }

      await db.query("BEGIN");

      const featCol = await getFeaturedColumnName();
      const { rows: profRows } = await db.query(
        `INSERT INTO creator_profiles (user_id, display_name, bio, profile_image, ${featCol}, is_profile_complete, created_at, updated_at)
         VALUES ($1,$2,$3,$4,false, TRUE, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET display_name        = COALESCE(EXCLUDED.display_name, creator_profiles.display_name),
               bio                 = COALESCE(EXCLUDED.bio,          creator_profiles.bio),
               profile_image       = COALESCE(EXCLUDED.profile_image,creator_profiles.profile_image),
               is_profile_complete = TRUE,
               updated_at          = NOW()
         RETURNING user_id, display_name, bio, profile_image, ${featuredExpr} AS is_featured, is_profile_complete`,
        [userId, display_name || null, bio || null, profile_image_url || null]
      );

      if (gallery_urls) {
        await db.query(`DELETE FROM creator_profile_photos WHERE user_id=$1`, [userId]);

        if (gallery_urls.length) {
          const values = gallery_urls.map((_, i) => `($1,$${i + 2},$${i + 2 + gallery_urls.length})`).join(",");
          const params = [userId, ...gallery_urls, ...gallery_urls.map((_, i) => i + 1)];
          await db.query(
            `INSERT INTO creator_profile_photos (user_id, url, position) VALUES ${values}`,
            params
          );
        }
      }

      const { rows: galleryRows } = await db.query(
        `SELECT ARRAY_AGG(url ORDER BY position) AS gallery
           FROM creator_profile_photos WHERE user_id=$1`,
        [userId]
      );

      await db.query("COMMIT");

      const status = await recomputeCreatorActive(db, userId);

      return res.json({
        profile: {
          ...profRows[0],
          // keep legacy "featured" field in payload for callers that expect it
          featured: !!profRows[0]?.is_featured,
          gallery: galleryRows?.[0]?.gallery || [],
        },
        creator_status: status,
      });
    } catch (e) {
      try { await db.query("ROLLBACK"); } catch {}
      console.error("creator profile save error:", e);
      return res.status(500).json({ error: "Failed to save profile" });
    }
  }
);

/**
 * GET my (raw) creator profile (no eligibility gating) + gallery
 */
router.get("/me", requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows: prof } = await db.query(
      `SELECT user_id, display_name, bio, profile_image, ${featuredExpr} AS is_featured, is_profile_complete, is_active
         FROM creator_profiles cp WHERE user_id=$1 LIMIT 1`,
      [userId]
    );
    const profile = prof[0] || null;

    const { rows: photos } = await db.query(
      `SELECT url, position FROM creator_profile_photos WHERE user_id=$1 ORDER BY position ASC`,
      [userId]
    );
    const gallery = photos.map((p) => p.url).slice(0, 4);

    return res.json({
      user_id: userId,
      display_name: profile?.display_name || null,
      bio: profile?.bio || null,
      profile_image: profile?.profile_image || null,
      // keep "featured" for legacy; expose new "is_featured" too
      featured: !!profile?.is_featured,
      is_featured: !!profile?.is_featured,
      is_profile_complete: profile?.is_profile_complete || false,
      is_active: profile?.is_active || false,
      gallery,
    });
  } catch (e) {
    console.error("get my creator profile error:", e);
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

/**
 * PATCH: Update ONLY my profile image (single file)
 */
router.patch(
  "/me/profile-image",
  requireAuth,
  uploadSingleImage.single("profile_image"),
  async (req, res) => {
    const userId = req.user.id;
    try {
      if (!req.file) return res.status(400).json({ error: "profile_image file is required" });
      const url = toPublicUrl(req.file.path);
      if (!url) return res.status(500).json({ error: "Failed to store image" });
      // Try UPDATE first (schema-aware update of updated_at if column exists)
      const hasUpdatedAt = await hasColumn("creator_profiles", "updated_at").catch(() => false);
      const updateSets = ["profile_image=$2"]; // base set
      if (hasUpdatedAt) updateSets.push("updated_at=NOW()");
      const updateSql = `UPDATE creator_profiles SET ${updateSets.join(",")} WHERE user_id=$1`;
      const upd = await db.query(updateSql, [userId, url]);

      if (upd.rowCount === 0) {
        // Need to INSERT minimal row (schema-aware for optional columns)
        const cols = ["user_id", "profile_image"]; // mandatory
        const vals = ["$1", "$2"]; // placeholders
        const params = [userId, url];
        const optionalCols = [
          { name: "featured", value: "FALSE" },
          { name: "is_featured", value: "FALSE" },
          { name: "is_profile_complete", value: "FALSE" },
          { name: "created_at", value: "NOW()" },
          { name: "updated_at", value: "NOW()" },
        ];
        for (const oc of optionalCols) {
          // eslint-disable-next-line no-await-in-loop
          const exists = await hasColumn("creator_profiles", oc.name).catch(() => false);
          if (exists) {
            cols.push(oc.name);
            vals.push(oc.value);
          }
        }
        const insertSql = `INSERT INTO creator_profiles (${cols.join(",")}) VALUES (${vals.join(",")})`;
        await db.query(insertSql, params);
      }
      return res.json({ profile_image: url });
    } catch (e) {
      console.error("update profile image error:", e);
      return res.status(500).json({ error: "Failed to update profile image" });
    }
  }
);

/**
 * PATCH: Replace ONE gallery photo by position (1-4)
 * Field name: photo
 */
router.patch(
  "/me/gallery/:position",
  requireAuth,
  uploadSingleImage.single("photo"),
  async (req, res) => {
    const userId = req.user.id;
    const pos = parseInt(req.params.position, 10);
    if (Number.isNaN(pos) || pos < 1 || pos > 4) {
      return res.status(400).json({ error: "position must be 1-4" });
    }
    try {
      if (!req.file) return res.status(400).json({ error: "photo file is required" });
      const url = toPublicUrl(req.file.path);
      if (!url) return res.status(500).json({ error: "Failed to store image" });
      // Ensure profile row exists (schema-aware minimal insert)
      const { rows: existing } = await db.query(
        `SELECT 1 FROM creator_profiles WHERE user_id=$1 LIMIT 1`,
        [userId]
      );
      if (!existing.length) {
        const cols = ["user_id"]; const vals = ["$1"]; const params = [userId];
        const optionalCols = [
          { name: "is_active", value: "FALSE" },
          { name: "featured", value: "FALSE" },
          { name: "is_featured", value: "FALSE" },
          { name: "is_profile_complete", value: "FALSE" },
          { name: "created_at", value: "NOW()" },
          { name: "updated_at", value: "NOW()" },
        ];
        for (const oc of optionalCols) {
          // eslint-disable-next-line no-await-in-loop
          const exists = await hasColumn("creator_profiles", oc.name).catch(() => false);
          if (exists) { cols.push(oc.name); vals.push(oc.value); }
        }
        const insertSql = `INSERT INTO creator_profiles (${cols.join(",")}) VALUES (${vals.join(",")})`;
        await db.query(insertSql, params);
      }

      await db.query(`DELETE FROM creator_profile_photos WHERE user_id=$1 AND position=$2`, [userId, pos]);
      await db.query(
        `INSERT INTO creator_profile_photos (user_id, url, position) VALUES ($1,$2,$3)`,
        [userId, url, pos]
      );

      const { rows: photos } = await db.query(
        `SELECT url, position FROM creator_profile_photos WHERE user_id=$1 ORDER BY position`,
        [userId]
      );
      const gallery = photos.map((p) => p.url).slice(0, 4);
      return res.json({ position: pos, url, gallery });
    } catch (e) {
      console.error("update gallery photo error:", e);
      return res.status(500).json({ error: "Failed to update gallery photo" });
    }
  }
);

/**
 * PUBLIC: Get a creator profile (gated/eligible)
 */
router.get("/:creatorId", async (req, res) => {
  const creatorId = req.creatorId;

  try {
    const enabledClause = await usersEnabledClause();

    const { rows } = await db.query(
      `
      SELECT
        cp.user_id,
        cp.display_name,
        cp.bio,
        cp.profile_image,
        ${featuredExpr} AS is_featured,
        COALESCE(AVG(r.rating),0)::numeric(3,2) AS average_rating,
        COUNT(DISTINCT p.id)::int               AS products_count
      FROM creator_profiles cp
      JOIN users u
        ON u.id = cp.user_id
      LEFT JOIN reviews  r
        ON r.creator_id = cp.user_id
      LEFT JOIN products p
        ON p.user_id = cp.user_id
       AND p.active  = TRUE
      WHERE cp.user_id = $1
        AND ${enabledClause}
        AND u.role = 'creator'
        AND cp.is_profile_complete = TRUE
        AND cp.is_active = TRUE
      GROUP BY cp.user_id, cp.display_name, cp.bio, cp.profile_image, ${featuredExpr}
      HAVING COUNT(DISTINCT p.id) > 0
      `,
      [creatorId]
    );

    if (!rows.length) return res.status(404).json({ error: "Creator profile not found or not eligible" });

    const base = rows[0];

    const { rows: cats } = await db.query(
      `SELECT c.name
         FROM creator_categories cc
         JOIN categories c ON c.id = cc.category_id
        WHERE cc.creator_id = $1
        ORDER BY c.name ASC`,
      [creatorId]
    );
    const categories = cats.map((c) => c.name);

    const { rows: photos } = await db.query(
      `SELECT ARRAY_AGG(url ORDER BY position) AS gallery
         FROM creator_profile_photos WHERE user_id=$1`,
      [creatorId]
    );

    res.json({
      ...base,
      featured: !!base.is_featured, // keep legacy field name too
      categories,
      gallery: photos?.[0]?.gallery || [],
    });
  } catch (e) {
    console.error("public profile error:", e);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

/**
 * Update my creator profile + categories (admin or self)
 */
router.put("/:creatorId", requireAuth, async (req, res) => {
  const creatorId = req.creatorId;

  const isAdmin = req.user?.role === "admin";
  if (!isAdmin && req.user?.id !== creatorId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const display_name = typeof req.body.display_name === "string" ? req.body.display_name.trim() : null;
  const bio = typeof req.body.bio === "string" ? req.body.bio.trim() : null;

  const rawCats = Array.isArray(req.body.categories) ? req.body.categories : null;
  const toLower = (s) => String(s || "").trim().toLowerCase();
  const parseCategoryInput = (arr) => {
    const names = [];
    const ids = [];
    for (const it of arr) {
      if (typeof it === "string") names.push(it.trim());
      else if (typeof it === "number") ids.push(it);
      else if (it && typeof it === "object") {
        if (typeof it.id === "number") ids.push(it.id);
        else if (typeof it.name === "string") names.push(it.name.trim());
      }
    }
    return { names, ids };
  };

  try {
    await db.query("BEGIN");

    if (display_name !== null || bio !== null) {
      const { rowCount } = await db.query(
        `UPDATE creator_profiles
            SET display_name = COALESCE($1, display_name),
                bio          = COALESCE($2, bio),
                updated_at   = NOW()
          WHERE user_id = $3`,
        [display_name, bio, creatorId]
      );

      if (rowCount === 0) {
        const featCol = await getFeaturedColumnName();
        await db.query(
          `INSERT INTO creator_profiles (user_id, display_name, bio, profile_image, ${featCol}, is_profile_complete, created_at, updated_at)
           VALUES ($1, $2, $3, NULL, FALSE, FALSE, NOW(), NOW())`,
          [creatorId, display_name, bio]
        );
      }
    }

    if (rawCats) {
      const { names, ids } = parseCategoryInput(rawCats);
      let allIds = ids.slice();

      if (names.length) {
        const { rows } = await db.query(
          `SELECT id, name FROM categories WHERE active = TRUE AND lower(name) = ANY($1::text[])`,
          [names.map(toLower)]
        );
        const foundLower = rows.map((r) => r.name.toLowerCase());
        const missing = names.filter((n) => !foundLower.includes(n.toLowerCase()));

        if (missing.length) {
          await db.query("ROLLBACK");
          return res.status(400).json({ error: "Unknown categories", details: { missing } });
        }

        allIds = allIds.concat(rows.map((r) => r.id));
      }

      await db.query(`DELETE FROM creator_categories WHERE creator_id=$1`, [creatorId]);
      if (allIds.length) {
        const values = allIds.map((_, i) => `($1,$${i + 2})`).join(",");
        await db.query(
          `INSERT INTO creator_categories (creator_id, category_id) VALUES ${values}`,
          [creatorId, ...allIds]
        );
      }
    }

    const { rows: prof } = await db.query(
      `SELECT user_id AS creator_id, display_name, bio, profile_image, ${featuredExpr} AS is_featured
         FROM creator_profiles cp WHERE user_id=$1 LIMIT 1`,
      [creatorId]
    );

    const { rows: cats } = await db.query(
      `SELECT c.name
         FROM creator_categories cc
         JOIN categories c ON c.id = cc.category_id
        WHERE cc.creator_id = $1
        ORDER BY c.name ASC`,
      [creatorId]
    );

    await db.query("COMMIT");

    return res.json({
      ...(prof[0] || { creator_id: creatorId, display_name, bio, profile_image: null, is_featured: false }),
      featured: !!(prof[0]?.is_featured || false), // legacy field
      categories: cats.map((c) => c.name),
    });
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch {}
    console.error("update creator error:", e);
    return res.status(500).json({ error: "Could not update creator" });
  }
});

/**
 * Set my categories
 */
router.post("/me/categories", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { category_ids } = req.body || {};
  const ids = Array.isArray(category_ids) ? category_ids.map((n) => parseInt(n, 10)).filter(Boolean) : [];

  try {
    await db.query("BEGIN");
    await db.query(`DELETE FROM creator_categories WHERE creator_id=$1`, [userId]);

    if (ids.length) {
      const values = ids.map((_, i) => `($1,$${i + 2})`).join(",");
      await db.query(`INSERT INTO creator_categories (creator_id, category_id) VALUES ${values}`, [userId, ...ids]);
    }
    await db.query("COMMIT");

    res.json({ success: true, category_ids: ids });
  } catch (e) {
    await db.query("ROLLBACK");
    console.error("set categories error:", e);
    res.status(500).json({ error: "Failed to set categories" });
  }
});

/**
 * ADMIN: Set/unset featured creator
 */
router.patch("/:creatorId/featured", requireAuth, requireAdmin, async (req, res) => {
  const creatorId = req.creatorId;
  const { featured } = req.body || {};
  const flag = !!featured;

  try {
    const featCol = await getFeaturedColumnName();
    const { rows } = await db.query(
      `UPDATE creator_profiles
          SET ${featCol}=$1, updated_at=NOW()
        WHERE user_id=$2
        RETURNING user_id, display_name, bio, profile_image, ${featuredExpr} AS is_featured`,
      [flag, creatorId]
    );
    if (!rows.length) return res.status(404).json({ error: "Creator profile not found" });

    try {
      await db.query(
        `INSERT INTO admin_actions (admin_id, action, target_type, target_id, payload_json)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.user.id, flag ? "feature_creator" : "unfeature_creator", "user", creatorId, JSON.stringify({ featured: flag })]
      );
    } catch {}

    res.json({ success: true, profile: { ...rows[0], featured: !!rows[0].is_featured } });
  } catch (e) {
    console.error("set featured error:", e);
    res.status(500).json({ error: "Failed to update featured flag" });
  }
});

/**
 * PUBLIC: Creator card (front/back) — eligible only
 */
router.get("/:creatorId/card", async (req, res) => {
  const creatorId = req.creatorId;

  try {
    const enabledClause = await usersEnabledClause();

    const { rows: prof } = await db.query(
      `
      SELECT
        cp.user_id AS creator_id,
        cp.display_name,
        cp.bio,
        cp.profile_image,
        ${featuredExpr} AS is_featured,
        COALESCE(AVG(r.rating),0)::numeric(3,2) AS average_rating,
        COUNT(DISTINCT p.id)::int               AS products_count
      FROM creator_profiles cp
      JOIN users u
        ON u.id = cp.user_id
      LEFT JOIN reviews  r
        ON r.creator_id = cp.user_id
      LEFT JOIN products p
        ON p.user_id = cp.user_id
       AND p.active  = TRUE
      WHERE cp.user_id = $1
        AND ${enabledClause}
        AND u.role = 'creator'
        AND cp.is_profile_complete = TRUE
        AND cp.is_active = TRUE
      GROUP BY cp.user_id, cp.display_name, cp.bio, cp.profile_image, ${featuredExpr}
      HAVING COUNT(DISTINCT p.id) > 0
      `,
      [creatorId]
    );
    if (!prof.length) return res.status(404).json({ error: "Creator profile not found or not eligible" });

    const p = prof[0];

    // categories: include slug if present, else derive from name
    const slugExists = await hasColumn("categories", "slug");

    const { rows: cats } = await db.query(
      `
      SELECT ${slugExists ? "c.id, c.name, c.slug" : "c.id, c.name, lower(regexp_replace(c.name,'\\s+','-','g')) AS slug"}
      FROM creator_categories cc
      JOIN categories c ON c.id = cc.category_id
      WHERE cc.creator_id = $1
      ORDER BY c.name ASC
      `,
      [creatorId]
    );

    const { rows: photoAgg } = await db.query(
      `SELECT ARRAY_AGG(url ORDER BY position) AS gallery
         FROM creator_profile_photos WHERE user_id=$1`,
      [creatorId]
    );
    const gallery = (photoAgg?.[0]?.gallery || []).slice(0, 4);

    const { rows: prods } = await db.query(
      `
      SELECT id, title, product_type, price
      FROM (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) rn
        FROM products
      ) t
      WHERE user_id = $1 AND active = TRUE AND rn <= 4
      `,
      [creatorId]
    );

    const card = {
      creator_id: p.creator_id,
      front: {
        display_name: p.display_name,
        bio: p.bio,
        profile_image: p.profile_image,
        categories: cats,
        average_rating: p.average_rating,
        products_count: p.products_count,
        featured: !!p.is_featured,
        products_preview: prods,
      },
      back: { gallery },
      links: { profile: `/creators/${p.creator_id}` },
    };

    res.json(card);
  } catch (e) {
    console.error("creator card error:", e);
    res.status(500).json({ error: "Failed to fetch creator" });
  }
});

/**
 * PUBLIC: Explore creators (eligible only)
 * Works whether or not categories.slug or users.enabled exist.
 */
router.get("/", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "24", 10), 60);
  const offset = parseInt(req.query.offset || "0", 10);
  const q = (req.query.q || "").trim();
  const categoryId = parseInt(req.query.categoryId || req.query.category_id || "", 10);

  const params = [];
  const enabledClause = await usersEnabledClause();
  const where = [
    enabledClause,                // conditional users.enabled
    "u.role = 'creator'",
    "cp.is_profile_complete = TRUE",
    "cp.is_active = TRUE",
  ];

  if (q) {
    params.push(`%${q}%`);
    where.push(`(cp.display_name ILIKE $${params.length} OR cp.bio ILIKE $${params.length})`);
  }

  if (!isNaN(categoryId)) {
    params.push(categoryId);
    where.push(`EXISTS (
      SELECT 1 FROM creator_categories cc
      WHERE cc.creator_id = cp.user_id AND cc.category_id = $${params.length}
    )`);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  try {
    const { rows: profiles } = await db.query(
      `
      SELECT
        cp.user_id AS creator_id,
        cp.display_name,
        cp.bio,
        cp.profile_image,
        ${featuredExpr} AS is_featured,
        COALESCE(AVG(r.rating),0)::numeric(3,2) AS average_rating,
        COUNT(DISTINCT p.id)::int               AS products_count
      FROM creator_profiles cp
      JOIN users u
        ON u.id = cp.user_id
      LEFT JOIN reviews  r
        ON r.creator_id = cp.user_id
      LEFT JOIN products p
        ON p.user_id = cp.user_id
       AND p.active  = TRUE
      ${whereSql}
      GROUP BY cp.user_id, cp.display_name, cp.bio, cp.profile_image, ${featuredExpr}
      HAVING COUNT(DISTINCT p.id) > 0
      ORDER BY average_rating DESC NULLS LAST, products_count DESC, cp.display_name ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, limit, offset]
    );

    if (!profiles.length) {
      return res.json({ creators: [] });
    }

    const creatorIds = profiles.map((p) => p.creator_id);

    // Categories per creator (slug conditional)
    const slugExists = await hasColumn("categories", "slug");

    let categoriesByCreator = {};
    if (creatorIds.length) {
      const { rows: categories } = await db.query(
        `
        SELECT
          cc.creator_id,
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', c.id,
              'name', c.name,
              'slug', ${slugExists ? "c.slug" : "lower(regexp_replace(c.name,'\\s+','-','g'))"}
            )
            ORDER BY c.name
          ) AS categories
        FROM creator_categories cc
        JOIN categories c ON c.id = cc.category_id
        WHERE cc.creator_id = ANY($1::int[])
        GROUP BY cc.creator_id
        `,
        [creatorIds]
      );
      categoriesByCreator = Object.fromEntries(categories.map((c) => [c.creator_id, c.categories || []]));
    }

    // Photos per creator
    let photosByCreator = {};
    if (creatorIds.length) {
      const { rows: photos } = await db.query(
        `
        SELECT user_id AS creator_id, ARRAY_AGG(url ORDER BY position) AS gallery
        FROM creator_profile_photos
        WHERE user_id = ANY($1::int[])
        GROUP BY user_id
        `,
        [creatorIds]
      );
      photosByCreator = Object.fromEntries(photos.map((p) => [p.creator_id, p.gallery || []]));
    }

    const out = profiles.map((p) => ({
      creator_id: p.creator_id,
      display_name: p.display_name,
      bio: p.bio,
      profile_image: p.profile_image,
      gallery: photosByCreator[p.creator_id] || [],
      average_rating: p.average_rating,
      products_count: p.products_count,
      categories: categoriesByCreator[p.creator_id] || [],
      featured: !!p.is_featured,         // legacy naming
      is_featured: !!p.is_featured,      // new naming
    }));

    res.json({ creators: out });
  } catch (e) {
    console.error("list creators error:", e);
    res.status(500).json({ error: "Failed to fetch creators" });
  }
});

/**
 * PUBLIC: Featured creators (eligible only)
 * - users.enabled = TRUE (if column exists)
 * - u.role = 'creator'
 * - cp.is_profile_complete = TRUE
 * - cp.is_active = TRUE
 * - cp.is_featured/featured = TRUE
 * - ≥1 active product
 */
router.get("/featured", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "12", 10), 24);

  try {
    const enabledClause = await usersEnabledClause();

    const { rows: profiles } = await db.query(
      `
      SELECT
        cp.user_id AS creator_id,
        cp.display_name,
        cp.bio,
        cp.profile_image,
        ${featuredExpr} AS is_featured,
        COALESCE(AVG(r.rating),0)::numeric(3,2) AS average_rating,
        COUNT(DISTINCT p.id)::int               AS products_count
      FROM creator_profiles cp
      JOIN users u
        ON u.id = cp.user_id
      LEFT JOIN reviews  r
        ON r.creator_id = cp.user_id
      LEFT JOIN products p
        ON p.user_id = cp.user_id
       AND p.active  = TRUE
      WHERE ${enabledClause}
        AND u.role = 'creator'
        AND cp.is_profile_complete = TRUE
        AND cp.is_active = TRUE
        AND ${featuredExpr} = TRUE
      GROUP BY cp.user_id, cp.display_name, cp.bio, cp.profile_image, ${featuredExpr}
      ORDER BY average_rating DESC NULLS LAST, products_count DESC, cp.display_name ASC
      LIMIT $1
      `,
      [limit]
    );

    if (profiles.length === 0) return res.json({ creators: [] });

    const creatorIds = profiles.map((p) => p.creator_id);

    // categories (slug-safe)
    const slugExists = await hasColumn("categories", "slug");
    const catExpr = slugExists ? "c.slug" : "lower(regexp_replace(c.name,'\\s+','-','g'))";
    const { rows: categories } = await db.query(
      `
      SELECT
        cc.creator_id,
        JSON_AGG(
          JSON_BUILD_OBJECT('id', c.id, 'name', c.name, 'slug', ${catExpr})
          ORDER BY c.name
        ) AS categories
      FROM creator_categories cc
      JOIN categories c ON c.id = cc.category_id
      WHERE cc.creator_id = ANY($1::int[])
      GROUP BY cc.creator_id
      `,
      [creatorIds]
    );
    const catsByCreator = Object.fromEntries(categories.map((r) => [r.creator_id, r.categories || []]));

    // gallery (first 4)
    const { rows: photos } = await db.query(
      `
      SELECT user_id AS creator_id, ARRAY_AGG(url ORDER BY position) AS gallery
      FROM creator_profile_photos
      WHERE user_id = ANY($1::int[])
      GROUP BY user_id
      `,
      [creatorIds]
    );
    const photosByCreator = Object.fromEntries(photos.map((r) => [r.creator_id, (r.gallery || []).slice(0, 4)]));

    const out = profiles.map((p) => ({
      creator_id: p.creator_id,
      display_name: p.display_name,
      bio: p.bio,
      profile_image: p.profile_image,
      average_rating: p.average_rating,
      products_count: p.products_count,
      categories: catsByCreator[p.creator_id] || [],
      gallery: photosByCreator[p.creator_id] || [],
      featured: !!p.is_featured,
      is_featured: !!p.is_featured,
    }));

    res.json({ creators: out });
  } catch (e) {
    console.error("featured creators error:", e);
    res.status(500).json({ error: "Failed to fetch featured creators" });
  }
});

module.exports = router;