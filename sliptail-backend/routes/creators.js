// routes/creators.js
const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { recomputeCreatorActive } = require("../services/creatorStatus");
const jwt = require("jsonwebtoken");

// media upload deps
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const storage = require("../storage"); // ← NEW: local or S3 depending on env
const crypto = require("crypto");

const router = express.Router();

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
  const rel = absPath.slice(idx).replace(/\\/g, "/");
  return `/${rel}`;
}

// NEW: S3 key builders + URL helper
function s3KeyForProfile(userId, originalName) {
  const ext = path.extname(originalName || "").toLowerCase() || ".jpg";
  const ts  = Date.now(); // or a content hash if you prefer
  return `creators/${userId}/profile/${ts}${ext}`;
  }

// With this (timestamp + short hash → unique key per upload):
function s3KeyForGallery(userId, index, originalName, buffer) {
  const ext = path.extname(originalName || "").toLowerCase() || ".jpg";
  const ts  = Date.now();
  const h   = buffer ? crypto.createHash("md5").update(buffer).digest("hex").slice(0,8) : Math.random().toString(36).slice(2,8);
  return `creators/${userId}/gallery/${index}-${ts}-${h}${ext}`;
}
function urlFromUploadedPublic(uploaded) {
  // Prefer driver helpers if available; fall back to key
  return (storage.publicUrl && storage.publicUrl(uploaded.key)) || uploaded.url || uploaded.key;
}

// --- Cleanup helper: delete older S3 objects for this gallery slot (non-blocking) ---
async function cleanupOldGalleryObjects(userId, pos, keepKeyOrUrl) {
  if (!storage.isS3) return; // local driver: nothing to do

  try {
    // 1) Normalize the "key" we want to keep
    const keepKey = (typeof storage.keyFromPublicUrl === "function")
      ? storage.keyFromPublicUrl(keepKeyOrUrl)
      : (String(keepKeyOrUrl || "").startsWith("http")
          ? new URL(String(keepKeyOrUrl)).pathname.replace(/^\/+/, "")
          : String(keepKeyOrUrl || "").replace(/^\/+/, ""));

    // 2) List everything under creators/<userId>/gallery/<pos>-
    const prefix = `creators/${userId}/gallery/${pos}-`;
    if (typeof storage.listPublicPrefix !== "function" || typeof storage.deletePublic !== "function") {
      // If helpers are missing, just exit (safe no-op)
      return;
    }

    const keys = await storage.listPublicPrefix(prefix);
    const toDelete = (keys || []).filter((k) => k !== keepKey);

    // 3) Best-effort delete (don't await every one in series)
    await Promise.allSettled(toDelete.map((k) => storage.deletePublic(k)));
  } catch {
    // Non-blocking: ignore cleanup failures
  }
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
  // default to 'featured' if neither found (rare)
  return "featured";
}

// Reusable SQL expression for reading "is featured?"
const featuredExpr = "COALESCE(cp.is_featured, cp.featured, FALSE)";

// Ensure a blank creator_profiles row exists for this user (idempotent + schema-aware)
async function ensureCreatorProfileShell(userId) {
  async function colInfo(name) {
    const { rows } = await db.query(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='creator_profiles' AND column_name=$1
        LIMIT 1`,
      [name]
    );
    return rows.length ? { exists: true, nullable: rows[0].is_nullable === "YES" } : { exists: false, nullable: true };
  }

  const info = {};
  for (const c of [
    "display_name",
    "bio",
    "profile_image",
    "is_profile_complete",
    "is_active",
    "created_at",
    "updated_at",
    "is_featured",
    "featured",
  ]) {
    // eslint-disable-next-line no-await-in-loop
    info[c] = await colInfo(c);
  }

  const cols = ["user_id"];
  const vals = ["$1"];

  if (info.display_name.exists)       { cols.push("display_name");        vals.push(info.display_name.nullable ? "NULL" : "''"); }
  if (info.bio.exists)                { cols.push("bio");                 vals.push(info.bio.nullable ? "NULL" : "''"); }
  if (info.profile_image.exists)      { cols.push("profile_image");       vals.push("NULL"); }
  if (info.is_profile_complete.exists){ cols.push("is_profile_complete"); vals.push("FALSE"); }
  if (info.is_active.exists)          { cols.push("is_active");           vals.push("FALSE"); }
  if (info.created_at.exists)         { cols.push("created_at");          vals.push("NOW()"); }
  if (info.updated_at.exists)         { cols.push("updated_at");          vals.push("NOW()"); }
  if (info.is_featured.exists)        { cols.push("is_featured");         vals.push("FALSE"); }
  else if (info.featured.exists)      { cols.push("featured");            vals.push("FALSE"); }

  const sql = `
    INSERT INTO creator_profiles (${cols.join(",")})
    SELECT ${vals.join(",")}
    WHERE NOT EXISTS (SELECT 1 FROM creator_profiles WHERE user_id=$1)
  `;
  await db.query(sql, [userId]);
}

/* --------------------------- media upload setup --------------------------- */

const creatorUploadRoot = path.join(__dirname, "..", "public", "uploads", "creators");
if (!fs.existsSync(creatorUploadRoot)) {
  fs.mkdirSync(creatorUploadRoot, { recursive: true });
}
const imageMimes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

// In S3 mode we read into memory and upload to public bucket.
// In local mode we keep your original disk behavior.
let uploadCreatorMedia, uploadSingleImage;

if (storage.isS3) {
  const mem = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
    fileFilter: (req, file, cb) => {
      if (!imageMimes.has(file.mimetype)) return cb(new Error("Only image files are allowed"));
      cb(null, true);
    },
  });
  uploadCreatorMedia = mem;
  uploadSingleImage = mem;
} else {
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

  uploadCreatorMedia = multer({
    storage: creatorStorage,
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!imageMimes.has(file.mimetype)) return cb(new Error("Only image files are allowed"));
      cb(null, true);
    },
  });

  uploadSingleImage = multer({
    storage: creatorStorage,
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!imageMimes.has(file.mimetype)) return cb(new Error("Only image files are allowed"));
      cb(null, true);
    },
  });
}

/* =============================== reviews helpers =============================== */

function sanitizeRating(r) {
  const n = parseInt(String(r), 10);
  if (!Number.isFinite(n)) return null;
  return n >= 1 && n <= 5 ? n : null;
}

// Buyer must have paid/interacted with this creator in at least one valid way
async function hasEligibility(buyerId, creatorId, productId) {
  // Paid order for the same creator (optionally same product)
  const paid = await db.query(
    `SELECT 1
       FROM orders o
       JOIN products p ON p.id = o.product_id
      WHERE o.buyer_id=$1 AND p.user_id=$2 AND (o.status='paid' OR o.status='complete')
      ${productId ? "AND o.product_id=$3" : ""}
      LIMIT 1`,
    productId ? [buyerId, creatorId, productId] : [buyerId, creatorId]
  );
  if (paid.rows.length) return true;

  // Delivered custom request
  const delivered = await db.query(
    `SELECT 1 FROM custom_requests
      WHERE buyer_id=$1 AND creator_id=$2 AND status='delivered' LIMIT 1`,
    [buyerId, creatorId]
  );
  if (delivered.rows.length) return true;

  // Active membership for any product of this creator
  const activeMem = await db.query(
    `SELECT 1
       FROM memberships m
       JOIN products p ON p.id = m.product_id
      WHERE m.buyer_id=$1 AND p.user_id=$2 AND (m.status='active' OR m.status='trialing')
      LIMIT 1`,
    [buyerId, creatorId]
  );
  return activeMem.rows.length > 0;
}

/* --------------------------------- routes -------------------------------- */

router.post("/become", requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    await db.query("BEGIN");

    // Set role (idempotent)
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

    // ✅ Seed a shell creator profile row (idempotent + schema-safe)
    await ensureCreatorProfileShell(userId);

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

    return res.json({
      success: true,
      creator_id: userId,
      token,
      user: toSafeUser(user),
      seeded_profile: true,
    });
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch {}
    // eslint-disable-next-line no-console
    console.error("become creator error:", e);
    return res.status(500).json({ error: "Failed to become a creator" });
  }
});

/**
 * Idempotent setup: ensure a creator_profiles row exists and return it (with gallery & categories).
 */
router.post("/setup", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const agencyId = req.agency && req.agency.id;

  try {
    // If already exists, just return the current state (but make sure agency mapping is set)
    const { rows: existing } = await db.query(
      `SELECT user_id, display_name, bio, profile_image,
              COALESCE(is_profile_complete,FALSE) AS is_profile_complete,
              COALESCE(is_active,FALSE)           AS is_active
         FROM creator_profiles
        WHERE user_id=$1
        LIMIT 1`,
      [userId]
    );

    if (existing[0]) {
      // make sure this creator is attached to the current agency
      if (agencyId) {
        await db.query(
          `
          UPDATE creator_profiles
             SET agency_id = $1
           WHERE user_id = $2
             AND (agency_id IS NULL OR agency_id = $1)
          `,
          [agencyId, userId]
        );

        await db.query(
          `
          INSERT INTO agency_creators (agency_id, creator_user_id)
          VALUES ($1, $2)
          ON CONFLICT (agency_id, creator_user_id) DO NOTHING
          `,
          [agencyId, userId]
        );
      }

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

      return res.status(200).json({
        ok: true,
        creator: {
          user_id: userId,
          display_name: existing[0].display_name || null,
          bio: existing[0].bio || null,
          profile_image: existing[0].profile_image || null,
          is_profile_complete: !!existing[0].is_profile_complete,
          is_active: !!existing[0].is_active,
          gallery,
          categories: catsRows.map((c) => c.name),
        },
      });
    }

    // ------- Schema-aware INSERT: only include columns that exist (NO ON CONFLICT) -------
    const cols = ["user_id"];
    const vals = ["$1"];
    const params = [userId];

    const optionalCols = [
      { name: "display_name",        value: "NULL"  },
      { name: "bio",                 value: "NULL"  },
      { name: "profile_image",       value: "NULL"  },
      { name: "is_profile_complete", value: "FALSE" },
      { name: "is_active",           value: "FALSE" },
      { name: "created_at",          value: "NOW()" },
      { name: "updated_at",          value: "NOW()" },
      { name: "is_featured",         value: "FALSE" },
      { name: "featured",            value: "FALSE" },
    ];

    for (const oc of optionalCols) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await hasColumn("creator_profiles", oc.name).catch(() => false);
      if (exists) {
        cols.push(oc.name);
        vals.push(oc.value);
      }
    }

    const insertSql = `
      INSERT INTO creator_profiles (${cols.join(",")})
      SELECT ${vals.join(",")}
      WHERE NOT EXISTS (SELECT 1 FROM creator_profiles WHERE user_id=$1)
    `;
    await db.query(insertSql, params);

    // attach to agency for newly inserted profile
    if (agencyId) {
      await db.query(
        `
        UPDATE creator_profiles
           SET agency_id = $1
         WHERE user_id = $2
           AND (agency_id IS NULL OR agency_id = $1)
        `,
        [agencyId, userId]
      );

      await db.query(
        `
        INSERT INTO agency_creators (agency_id, creator_user_id)
        VALUES ($1, $2)
        ON CONFLICT (agency_id, creator_user_id) DO NOTHING
        `,
        [agencyId, userId]
      );
    }

    // Return the freshly created blank profile state
    const safeProfile = {
      user_id: userId,
      display_name: null,
      bio: null,
      profile_image: null,
      is_profile_complete: false,
      is_active: false,
      gallery: [],
      categories: [],
    };

    return res.status(201).json({ ok: true, creator: safeProfile });
  } catch (e) {
    console.error("creator/setup error:", e);
    return res
      .status(500)
      .json({ error: "Failed to save profile", details: e.message });
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
    try {
      await db.query("ROLLBACK");
    } catch {
      /* noop */
    }
    // eslint-disable-next-line no-console
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

          let profilePublic, galleryPublic;

          if (storage.isS3) {
            // Upload to PUBLIC bucket
            const uploadedProf = await storage.uploadPublic({
              key: s3KeyForProfile(userId, prof.originalname),
              contentType: prof.mimetype || "image/jpeg",
              body: prof.buffer,
            });
            profilePublic = urlFromUploadedPublic(uploadedProf);

            galleryPublic = [];
            for (let i = 0; i < gal.length; i += 1) {
              const g = gal[i];
              const up = await storage.uploadPublic({
                key: s3KeyForGallery(userId, i + 1, g.originalname, g.buffer), // ← pass buffer
                contentType: g.mimetype || "image/jpeg",
                body: g.buffer,
              });
              galleryPublic.push(urlFromUploadedPublic(up));
            }
          } else {
            // Local: keep your old behavior
            profilePublic = toPublicUrl(prof.path);
            galleryPublic = gal.map((f) => toPublicUrl(f.path)).filter(Boolean);
          }

          if (!profilePublic || galleryPublic.length !== 4) {
            return res.status(500).json({ error: "Failed to store images" });
          }

                    // Fire-and-forget cleanup for each slot (1..4)
          if (storage.isS3) {
            for (let i = 0; i < galleryPublic.length; i += 1) {
              const keep = galleryPublic[i];
              cleanupOldGalleryObjects(userId, i + 1, keep); // no await
            }
          }

          await db.query("BEGIN");

          // 1) UPDATE first (schema-aware updated_at if present)
          const hasUpdatedAt = await hasColumn("creator_profiles", "updated_at").catch(() => false);
          const updateSets = ["profile_image=$2"];
          if (hasUpdatedAt) updateSets.push("updated_at=NOW()");
          const upd = await db.query(
            `UPDATE creator_profiles SET ${updateSets.join(",")} WHERE user_id=$1`,
            [userId, profilePublic]
          );

          // 2) If no row updated → INSERT a minimal row (schema-aware, no ON CONFLICT)
          if (upd.rowCount === 0) {
            const cols = ["user_id", "profile_image"];
            const vals = ["$1", "$2"];
            const params = [userId, profilePublic];

            const optCols = [
              { name: "is_active",           value: "FALSE" },
              { name: "is_profile_complete", value: "FALSE" },
              { name: "is_featured",         value: "FALSE" },
              { name: "featured",            value: "FALSE" },
              { name: "created_at",          value: "NOW()" },
              { name: "updated_at",          value: "NOW()" },
            ];
            for (const oc of optCols) {
              const exists = await hasColumn("creator_profiles", oc.name).catch(() => false);
              if (exists) { cols.push(oc.name); vals.push(oc.value); }
            }

            const insertSql = `
              INSERT INTO creator_profiles (${cols.join(",")})
              SELECT ${vals.join(",")}
              WHERE NOT EXISTS (SELECT 1 FROM creator_profiles WHERE user_id=$1)
            `;
            await db.query(insertSql, params);
          }

          // 3) Replace gallery
          await db.query(`DELETE FROM creator_profile_photos WHERE user_id=$1`, [userId]);
          const values = galleryPublic.map((_, i) => `($1,$${i + 2},$${i + 2 + galleryPublic.length})`).join(",");
          const params = [userId, ...galleryPublic, ...galleryPublic.map((_, i) => i + 1)];
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
      const display_name = (req.body?.display_name || "").trim();
      const bio = (req.body?.bio || "").trim();

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

            if (storage.isS3) {
              const upProf = await storage.uploadPublic({
                key: s3KeyForProfile(userId, prof.originalname),
                contentType: prof.mimetype || "image/jpeg",
                body: prof.buffer,
              });
              profile_image_url = urlFromUploadedPublic(upProf);

              gallery_urls = [];
              for (let i = 0; i < gal.length; i += 1) {
                const g = gal[i];
                const up = await storage.uploadPublic({
                  key: s3KeyForGallery(userId, i + 1, g.originalname, g.buffer), // ← pass buffer
                  contentType: g.mimetype || "image/jpeg",
                  body: g.buffer,
                });
                gallery_urls.push(urlFromUploadedPublic(up));
              }

              // Fire-and-forget cleanup for each slot
              for (let i = 0; i < gallery_urls.length; i += 1) {
                cleanupOldGalleryObjects(userId, i + 1, gallery_urls[i]); // no await
              }
            } else {
              profile_image_url = toPublicUrl(prof.path);
              gallery_urls = gal.map((f) => toPublicUrl(f.path)).filter(Boolean);
            }

            if (!profile_image_url || gallery_urls.length !== 4) {
              return res.status(500).json({ error: "Failed to store images" });
          }
      } else {
        profile_image_url = req.body?.profile_image || null;
        const gallery = Array.isArray(req.body?.gallery) ? req.body.gallery : null;
        gallery_urls = gallery ? gallery.slice(0, 4).filter(Boolean) : null;
      }

              await db.query("BEGIN");

          // Figure out which featured column (if any) exists
          const featColName = await getFeaturedColumnName();
          const featExists = await hasColumn("creator_profiles", featColName).catch(() => false);
          const hasIsProfileComplete = await hasColumn("creator_profiles", "is_profile_complete").catch(() => false);
          const hasUpdatedAt = await hasColumn("creator_profiles", "updated_at").catch(() => false);
          const hasCreatedAt = await hasColumn("creator_profiles", "created_at").catch(() => false);

          // 1) Try UPDATE first (set provided fields; set is_profile_complete=TRUE if column exists)
          const setParts = [
            "display_name = $2",
            "bio = $3",
            "profile_image = $4",
          ];
          const updateParams = [userId, display_name || null, bio || null, profile_image_url || null];

          if (hasIsProfileComplete) setParts.push("is_profile_complete = TRUE");
          if (hasUpdatedAt) setParts.push("updated_at = NOW()");

          const updRes = await db.query(
            `UPDATE creator_profiles SET ${setParts.join(", ")} WHERE user_id = $1`,
            updateParams
          );

          // 2) If no row was updated → INSERT (schema-aware, no ON CONFLICT)
          if (updRes.rowCount === 0) {
            const cols = ["user_id", "display_name", "bio", "profile_image"];
            const vals = ["$1", "$2", "$3", "$4"];
            const params = [userId, display_name || null, bio || null, profile_image_url || null];

            if (featExists) { cols.push(featColName); vals.push("FALSE"); }
            if (hasIsProfileComplete) { cols.push("is_profile_complete"); vals.push("TRUE"); }
            if (hasCreatedAt) { cols.push("created_at"); vals.push("NOW()"); }
            if (hasUpdatedAt) { cols.push("updated_at"); vals.push("NOW()"); }

            const insertSql = `
              INSERT INTO creator_profiles (${cols.join(",")})
              SELECT ${vals.join(",")}
              WHERE NOT EXISTS (SELECT 1 FROM creator_profiles WHERE user_id=$1)
            `;
            await db.query(insertSql, params);
          }

          // 3) Gallery write (if provided)
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

          // 4) Read back gallery + return
          const { rows: galleryRows } = await db.query(
            `SELECT ARRAY_AGG(url ORDER BY position) AS gallery
              FROM creator_profile_photos WHERE user_id=$1`,
            [userId]
          );

          await db.query("COMMIT");

          // Build a schema-agnostic response (don’t rely on RETURNING w/ featuredExpr)
          const status = await recomputeCreatorActive(db, userId);

          // Read back minimal profile
          const { rows: profRows } = await db.query(
            `SELECT user_id, display_name, bio, profile_image,
                    COALESCE(is_profile_complete, FALSE) AS is_profile_complete,
                    COALESCE(is_featured, featured, FALSE) AS is_featured
              FROM creator_profiles
              WHERE user_id=$1 LIMIT 1`,
            [userId]
          );

          return res.json({
            profile: {
              user_id: profRows[0]?.user_id ?? userId,
              display_name: profRows[0]?.display_name ?? display_name ?? null,
              bio: profRows[0]?.bio ?? bio ?? null,
              profile_image: profRows[0]?.profile_image ?? profile_image_url ?? null,
              is_profile_complete: !!(profRows[0]?.is_profile_complete ?? true),
              is_featured: !!(profRows[0]?.is_featured ?? false),
              featured: !!(profRows[0]?.is_featured ?? false),
              gallery: galleryRows?.[0]?.gallery || [],
            },
            creator_status: status,
      });
    } catch (e) {
      try {
        await db.query("ROLLBACK");
      } catch {
        /* noop */
      }
      // eslint-disable-next-line no-console
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

    // Include current categories so frontend can highlight selections
    const { rows: catsRows } = await db.query(
      `SELECT c.name
         FROM creator_categories cc
         JOIN categories c ON c.id = cc.category_id
        WHERE cc.creator_id = $1
        ORDER BY c.name ASC`,
      [userId]
    );
    const categories = catsRows.map((c) => c.name);

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
      categories,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
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

            let url;
            if (storage.isS3) {
              const up = await storage.uploadPublic({
                key: s3KeyForProfile(userId, req.file.originalname),
                contentType: req.file.mimetype || "image/jpeg",
                body: req.file.buffer,
              });
              url = urlFromUploadedPublic(up);
            } else {
              url = toPublicUrl(req.file.path);
            }
            if (!url) return res.status(500).json({ error: "Failed to store image" });

            // Try UPDATE first (schema-aware update of updated_at if column exists)
            const hasUpdatedAt = await hasColumn("creator_profiles", "updated_at").catch(() => false);
            const updateSets = ["profile_image=$2"];
            if (hasUpdatedAt) updateSets.push("updated_at=NOW()");
            const updateSql = `UPDATE creator_profiles SET ${updateSets.join(",")} WHERE user_id=$1`;
            const upd = await db.query(updateSql, [userId, url]);

            if (upd.rowCount === 0) {
              // Need to INSERT minimal row (schema-aware for optional columns)
              const cols = ["user_id", "profile_image"];
              const vals = ["$1", "$2"];
              const params = [userId, url];
              const optionalCols = [
                { name: "featured", value: "FALSE" },
                { name: "is_featured", value: "FALSE" },
                { name: "is_profile_complete", value: "FALSE" },
                { name: "created_at", value: "NOW()" },
                { name: "updated_at", value: "NOW()" },
              ];
              for (const oc of optionalCols) {
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

            let url;
            if (storage.isS3) {
              const up = await storage.uploadPublic({
                key: s3KeyForGallery(userId, pos, req.file.originalname, req.file.buffer), // ← pass buffer
                contentType: req.file.mimetype || "image/jpeg",
                body: req.file.buffer,
              });
              url = urlFromUploadedPublic(up);
            } else {
              url = toPublicUrl(req.file.path);
            }
            if (!url) return res.status(500).json({ error: "Failed to store image" });

              // Fire-and-forget cleanup for this slot
            cleanupOldGalleryObjects(userId, pos, url);

            // Ensure profile row exists (schema-aware minimal insert)
            const { rows: existing } = await db.query(
              `SELECT 1 FROM creator_profiles WHERE user_id=$1 LIMIT 1`,
              [userId]
            );
            if (!existing.length) {
              const cols = ["user_id"];
              const vals = ["$1"];
              const params = [userId];
              const optionalCols = [
                { name: "is_active", value: "FALSE" },
                { name: "featured", value: "FALSE" },
                { name: "is_featured", value: "FALSE" },
                { name: "is_profile_complete", value: "FALSE" },
                { name: "created_at", value: "NOW()" },
                { name: "updated_at", value: "NOW()" },
              ];
              for (const oc of optionalCols) {
                const exists = await hasColumn("creator_profiles", oc.name).catch(() => false);
                if (exists) { cols.push(oc.name); vals.push(oc.value); }
              }
              const insertSql = `INSERT INTO creator_profiles (${cols.join(",")}) VALUES (${vals.join(",")})`;
              await db.query(insertSql, params);
            }

            await db.query(`DELETE FROM creator_profile_photos WHERE user_id=$1 AND position=$2`, [
              userId,
              pos,
            ]);
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
 * PUBLIC: Featured creators (eligible only)
 * NOTE: Keep this BEFORE any dynamic "/:creatorId" routes so "/featured" doesn't match the param route.
 */
router.get("/featured", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "12", 10), 24);

  try {
    const enabledClause = await usersEnabledClause();
    const agencyId = req.agency && req.agency.id;

    const params = [];
    const where = [
      enabledClause,
      "u.role = 'creator'",
      "cp.is_profile_complete = TRUE",
      "cp.is_active = TRUE",
      "cp.is_listed = TRUE",
      `${featuredExpr} = TRUE`,
    ];

    // If we are on an agency domain → only that agency’s creators
    // If we are on main Sliptail → only non-agency creators (agency_id IS NULL)
    if (agencyId) {
      params.push(agencyId);
      where.push(`cp.agency_id = $${params.length}`);
    } else {
      where.push("cp.agency_id IS NULL");
    }

    params.push(limit);
    const limitIdx = params.length;

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
      WHERE ${where.join(" AND ")}
      GROUP BY cp.user_id, cp.display_name, cp.bio, cp.profile_image, ${featuredExpr}
      ORDER BY average_rating DESC NULLS LAST, products_count DESC, cp.display_name ASC
      LIMIT $${limitIdx}
      `,
      params
    );

    if (profiles.length === 0) return res.json({ creators: [] });

    const creatorIds = profiles.map((p) => p.creator_id);

    // categories (slug safe)
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
    const catsByCreator = Object.fromEntries(
      categories.map((r) => [r.creator_id, r.categories || []])
    );

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
    const photosByCreator = Object.fromEntries(
      photos.map((r) => [r.creator_id, (r.gallery || []).slice(0, 4)])
    );

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

/* =============================== reviews endpoints =============================== */
/**
 * PUBLIC: List reviews for a creator (with product title & author)
 * Supports ?limit & ?offset. Placed BEFORE "/:creatorId" to avoid route clash.
 */
router.get("/:creatorId/reviews", async (req, res) => {
  const raw = (req.params.creatorId || "").trim();

  if (!raw) {
    return res.status(400).json({ error: "Missing creator id or slug" });
  }

  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

try {
  let creatorId = parseInt(raw, 10);
  const agencyId = req.agency && req.agency.id;

  if (Number.isNaN(creatorId) || String(creatorId) !== raw) {
    // Not a pure numeric id → resolve via slug-ish display_name
    const enabledClause = await usersEnabledClause();
    const decoded = decodeURIComponent(raw);
    const slugLike = decoded.trim();

    if (!slugLike) {
      return res.status(400).json({ error: "Invalid creator slug" });
    }

    const params = [slugLike];
    let agencyFilter = "";
    if (agencyId) {
      params.push(agencyId);
      agencyFilter = `AND cp.agency_id = $${params.length}`;
    }

    const { rows } = await db.query(
      `
      SELECT cp.user_id
      FROM creator_profiles cp
      JOIN users u ON u.id = cp.user_id
      WHERE
        regexp_replace(lower(trim(cp.display_name)), '[\\s-]+', '', 'g')
          = regexp_replace(lower($1), '[\\s-]+', '', 'g')
        AND ${enabledClause}
        AND u.role = 'creator'
        AND cp.is_profile_complete = TRUE
        AND cp.is_active = TRUE
        ${agencyFilter}
      LIMIT 1
      `,
      params
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Creator not found" });
    }

    creatorId = rows[0].user_id;
  }

  const { rows: list } = await db.query(
    `
    SELECT r.id,
           r.rating,
           r.comment,
           r.created_at,
           u.username AS author_name,
           COALESCE(p.title, NULL) AS product_title
    FROM reviews r
    JOIN users u ON u.id = r.buyer_id
    LEFT JOIN products p ON p.id = r.product_id
    WHERE r.creator_id = $1
    ORDER BY r.created_at DESC
    LIMIT $2 OFFSET $3
    `,
    [creatorId, limit, offset]
  );

  res.json({
    reviews: list,
    limit,
    offset,
  });
} catch (e) {
  console.error("creator reviews error:", e);
  res.status(500).json({ error: "Failed to fetch reviews" });
}
});

/**
 * AUTH: Create or update a review for a creator (alias used by Purchases page)
 * Upserts by (creator_id, buyer_id). Accepts { rating(1..5), comment?, product_id? }.
 */
router.post("/:creatorId/reviews", requireAuth, async (req, res) => {
  const buyerId = req.user.id;
  const creatorId = parseInt(req.params.creatorId, 10);
  if (Number.isNaN(creatorId)) return res.status(400).json({ error: "Invalid creator id" });

  const productId = req.body.product_id ? parseInt(req.body.product_id, 10) : null;
  const rating = sanitizeRating(req.body.rating);
  const comment = typeof req.body.comment === "string" ? req.body.comment.trim() : null;

  if (!rating) return res.status(400).json({ error: "rating must be an integer 1..5" });
  if (creatorId === buyerId) return res.status(400).json({ error: "You cannot review yourself" });

  try {
    const ok = await hasEligibility(buyerId, creatorId, productId || undefined);
    if (!ok) return res.status(403).json({ error: "Not eligible to review this creator" });

    // If already reviewed -> update; else insert
    const { rows: existing } = await db.query(
      `SELECT id FROM reviews WHERE creator_id=$1 AND buyer_id=$2 LIMIT 1`,
      [creatorId, buyerId]
    );

    if (existing.length) {
      const { rows } = await db.query(
        `UPDATE reviews
            SET rating=$1, comment=$2, product_id=$3, updated_at=NOW()
          WHERE id=$4
          RETURNING id, creator_id, buyer_id, rating, comment, product_id, created_at, updated_at`,
        [rating, comment, productId, existing[0].id]
      );
      return res.json({ review: rows[0], updated: true });
    }

    const { rows } = await db.query(
      `INSERT INTO reviews (product_id, creator_id, buyer_id, rating, comment, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       RETURNING id, creator_id, buyer_id, rating, comment, product_id, created_at`,
      [productId, creatorId, buyerId, rating, comment]
    );
    return res.status(201).json({ review: rows[0], created: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("create/update review error:", e);
    return res.status(500).json({ error: "Failed to submit review" });
  }
});

/**
 * PUBLIC: Get a creator profile (eligible only)
 */
router.get("/:creatorId", async (req, res) => {
  const raw = (req.params.creatorId || "").trim();

  if (!raw) {
    return res.status(400).json({ error: "Missing creator id or slug" });
  }

  try {
    const enabledClause = await usersEnabledClause();
    const agencyId = req.agency && req.agency.id;

    const numericId = parseInt(raw, 10);
    const isNumeric = !Number.isNaN(numericId) && String(numericId) === raw;

    let whereSql;
    const params = [];

    if (isNumeric) {
      // look up by user_id
      whereSql = "cp.user_id = $1";
      params.push(numericId);
    } else {
      // Treat as slug-ish identifier derived from display_name
      const decoded = decodeURIComponent(raw);
      const slugLike = decoded.trim();

      if (!slugLike) {
        return res.status(400).json({ error: "Invalid creator slug" });
      }

      whereSql =
        "regexp_replace(lower(trim(cp.display_name)), '[\\s-]+', '', 'g') = " +
        "regexp_replace(lower($1), '[\\s-]+', '', 'g')";
      params.push(slugLike);
    }

    if (agencyId) {
      params.push(agencyId);
      whereSql += ` AND cp.agency_id = $${params.length}`;
    } else {
      // Main Sliptail: only show creators that are not attached to any agency
      whereSql += " AND cp.agency_id IS NULL";
    }

    const { rows } = await db.query(
      `
      SELECT
        cp.user_id,
        cp.display_name,
        cp.bio,
        cp.profile_image,
        -- use stripe_connect as source of truth, fall back to profile flag, default false
        COALESCE(sc.charges_enabled, cp.stripe_charges_enabled, false) AS stripe_charges_enabled,
        ${featuredExpr} AS is_featured,
        COALESCE(r.avg_rating, 0)::numeric(3,2) AS average_rating,
        COALESCE(r.review_count, 0)::int        AS review_count,
        COALESCE(prod.products_count, 0)::int   AS products_count
      FROM creator_profiles cp
      JOIN users u
        ON u.id = cp.user_id
      LEFT JOIN stripe_connect sc
        ON sc.user_id = cp.user_id
      LEFT JOIN LATERAL (
        SELECT AVG(r.rating)::numeric(10,4) AS avg_rating,
               COUNT(*)::int                AS review_count
        FROM reviews r
        WHERE r.creator_id = cp.user_id
      ) r ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS products_count
        FROM products p
        WHERE p.user_id = cp.user_id
          AND p.active = TRUE
      ) prod ON TRUE
      WHERE ${whereSql}
        AND ${enabledClause}
        AND u.role = 'creator'
        AND cp.is_profile_complete = TRUE
        AND cp.is_active = TRUE
      LIMIT 1
      `,
      params
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Creator profile not found or not eligible" });
    }

    const base = rows[0];

    // Categories (simple names)
    const { rows: cats } = await db.query(
      `
      SELECT c.name
      FROM creator_categories cc
      JOIN categories c ON c.id = cc.category_id
      WHERE cc.creator_id = $1
      ORDER BY c.name ASC
      `,
      [base.user_id]
    );
    const categories = cats.map((c) => c.name);

    // Gallery photos
    const { rows: photos } = await db.query(
      `
      SELECT ARRAY_AGG(url ORDER BY position) AS gallery
      FROM creator_profile_photos
      WHERE user_id = $1
      `,
      [base.user_id]
    );
    const gallery = (photos[0] && photos[0].gallery) || [];

    res.json({
      ...base,
      categories,
      gallery,
    });
  } catch (e) {
    console.error("creator profile error:", e);
    res.status(500).json({ error: "Failed to fetch creator" });
  }
});

/**
 * Update my creator profile + categories (admin or self)
 */
router.put("/:creatorId", requireAuth, async (req, res) => {
  const creatorId = parseInt(req.params.creatorId, 10);
  if (Number.isNaN(creatorId)) return res.status(400).json({ error: "Invalid id" });

  const isAdmin = req.user?.role === "admin";
  if (!isAdmin && req.user?.id !== creatorId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const display_name =
    typeof req.body.display_name === "string" ? req.body.display_name.trim() : null;
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
      ...(prof[0] || {
        creator_id: creatorId,
        display_name,
        bio,
        profile_image: null,
        is_featured: false,
      }),
      featured: !!(prof[0]?.is_featured || false), // legacy field
      categories: cats.map((c) => c.name),
    });
  } catch (e) {
    try {
      await db.query("ROLLBACK");
    } catch {
      /* noop */
    }
    // eslint-disable-next-line no-console
    console.error("Could not update creator:", e);
    return res.status(500).json({ error: "Could not update creator" });
  }
});

/**
 * Set my categories
 */
router.post("/me/categories", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { category_ids } = req.body || {};
  const ids = Array.isArray(category_ids)
    ? category_ids.map((n) => parseInt(n, 10)).filter((v) => !Number.isNaN(v))
    : [];

  try {
    await db.query("BEGIN");
    await db.query(`DELETE FROM creator_categories WHERE creator_id=$1`, [userId]);

    if (ids.length) {
      const values = ids.map((_, i) => `($1,$${i + 2})`).join(",");
      await db.query(
        `INSERT INTO creator_categories (creator_id, category_id) VALUES ${values}`,
        [userId, ...ids]
      );
    }
    await db.query("COMMIT");

    res.json({ success: true, category_ids: ids });
  } catch (e) {
    await db.query("ROLLBACK");
    // eslint-disable-next-line no-console
    console.error("set categories error:", e);
    res.status(500).json({ error: "Failed to set categories" });
  }
});

/**
 * ADMIN: Set/unset featured creator
 */
router.patch("/:creatorId/featured", requireAuth, requireAdmin, async (req, res) => {
  const creatorId = parseInt(req.params.creatorId, 10);
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
        [
          req.user.id,
          flag ? "feature_creator" : "unfeature_creator",
          "user",
          creatorId,
          JSON.stringify({ featured: flag }),
        ]
      );
    } catch {
      /* non-blocking audit log */
    }

    res.json({ success: true, profile: { ...rows[0], featured: !!rows[0].is_featured } });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("set featured error:", e);
    res.status(500).json({ error: "Failed to update featured flag" });
  }
});

/**
 * PUBLIC: Creator card (front/back) — eligible only
 */
router.get("/:creatorId/card", async (req, res) => {
  const raw = (req.params.creatorId || "").trim();

  if (!raw) {
    return res.status(400).json({ error: "Missing creator id or slug" });
  }

  try {
    const enabledClause = await usersEnabledClause();
    const agencyId = req.agency && req.agency.id;

    const numericId = parseInt(raw, 10);
    const isNumeric = !Number.isNaN(numericId) && String(numericId) === raw;

    let whereSql;
    const params = [];

    if (isNumeric) {
      whereSql = "cp.user_id = $1";
      params.push(numericId);
    } else {
      const decoded = decodeURIComponent(raw);
      const slugLike = decoded.trim();

      if (!slugLike) {
        return res.status(400).json({ error: "Invalid creator slug" });
      }

      whereSql =
        "regexp_replace(lower(trim(cp.display_name)), '[\\s-]+', '', 'g') = " +
        "regexp_replace(lower($1), '[\\s-]+', '', 'g')";
      params.push(slugLike);
    }

    if (agencyId) {
      params.push(agencyId);
      whereSql += ` AND cp.agency_id = $${params.length}`;
    } else {
      whereSql += " AND cp.agency_id IS NULL";
    }

    const { rows: prof } = await db.query(
      `
      SELECT
        cp.user_id AS creator_id,
        cp.display_name,
        cp.bio,
        cp.profile_image,
        ${featuredExpr} AS is_featured,
        COALESCE(r.avg_rating, 0)::numeric(3,2) AS average_rating,
        COALESCE(r.review_count, 0)::int        AS review_count,
        COALESCE(prod.products_count, 0)::int   AS products_count
      FROM creator_profiles cp
      JOIN users u ON u.id = cp.user_id
      LEFT JOIN LATERAL (
        SELECT AVG(r.rating)::numeric(10,4) AS avg_rating,
               COUNT(*)::int                AS review_count
        FROM reviews r
        WHERE r.creator_id = cp.user_id
      ) r ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS products_count
        FROM products p
        WHERE p.user_id = cp.user_id
          AND p.active = TRUE
      ) prod ON TRUE
      WHERE ${whereSql}
        AND ${enabledClause}
        AND u.role = 'creator'
        AND cp.is_profile_complete = TRUE
        AND cp.is_active = TRUE
        AND COALESCE(prod.products_count, 0) > 0
      LIMIT 1
      `,
      params
    );

    if (!prof.length) {
      return res.status(404).json({ error: "Creator profile not found or not eligible" });
    }

    const p = prof[0];

    // categories: include slug if present, else derive from name
    const slugExists = await hasColumn("categories", "slug");

    const { rows: cats } = await db.query(
      `
      SELECT ${slugExists
        ? "c.id, c.name, c.slug"
        : "c.id, c.name, lower(regexp_replace(c.name,'\\s+','-','g')) AS slug"}
      FROM creator_categories cc
      JOIN categories c ON c.id = cc.category_id
      WHERE cc.creator_id = $1
      ORDER BY c.name ASC
      `,
      [p.creator_id]
    );

    const { rows: photoAgg } = await db.query(
      `
      SELECT ARRAY_AGG(url ORDER BY position) AS gallery
      FROM creator_profile_photos
      WHERE user_id = $1
      `,
      [p.creator_id]
    );
    const gallery = (photoAgg[0] && photoAgg[0].gallery) || [];

    const slugOrId =
      (p.display_name || "").trim().replace(/\s+/g, "-") || String(p.creator_id);

    const card = {
      creator_id: p.creator_id,
      front: {
        display_name: p.display_name,
        bio: p.bio,
        profile_image: p.profile_image,
        is_featured: p.is_featured,
        average_rating: p.average_rating,
        review_count: p.review_count,
        products_count: p.products_count,
        categories: cats,
      },
      back: { gallery },
      links: {
        profile: `/creators/${encodeURIComponent(slugOrId)}`,
      },
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
    enabledClause,
    "u.role = 'creator'",
    "cp.is_profile_complete = TRUE",
    "cp.is_active = TRUE",
    "cp.is_listed = TRUE",
  ];

  const agencyId = req.agency && req.agency.id;
  if (agencyId) {
    params.push(agencyId);
    where.push(`cp.agency_id = $${params.length}`);
  } else {
    where.push("cp.agency_id IS NULL");
  }

  if (q) {
    params.push(`%${q}%`);
    where.push(`(cp.display_name ILIKE $${params.length} OR cp.bio ILIKE $${params.length})`);
  }

  if (!Number.isNaN(categoryId)) {
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
      COALESCE(r.avg_rating, 0)::numeric(3,2) AS average_rating,
      COALESCE(r.review_count, 0)::int        AS review_count,
      COALESCE(prod.products_count, 0)::int   AS products_count
     FROM creator_profiles cp
     JOIN users u ON u.id = cp.user_id
     LEFT JOIN LATERAL (
       SELECT AVG(r.rating)::numeric(10,4) AS avg_rating,
              COUNT(*)::int                AS review_count
       FROM reviews r
       WHERE r.creator_id = cp.user_id
         AND (r.hidden IS NOT TRUE)
     ) r ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS products_count
       FROM products p
       WHERE p.user_id = cp.user_id
         AND p.active  = TRUE
     ) prod ON TRUE
     ${whereSql}
     AND COALESCE(prod.products_count, 0) > 0
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
      categoriesByCreator = Object.fromEntries(
        categories.map((c) => [c.creator_id, c.categories || []])
      );
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
      featured: !!p.is_featured,
      is_featured: !!p.is_featured,
    }));

    res.json({ creators: out });
  } catch (e) {
    console.error("list creators error:", e);
    res.status(500).json({ error: "Failed to fetch creators" });
  }
});

module.exports = router;