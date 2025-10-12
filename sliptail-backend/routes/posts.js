const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const db = require("../db");
const { requireAuth, requireCreator } = require("../middleware/auth");
const { notifyPostToMembers } = require("../utils/notify");

// NEW: generic storage layer (local or S3 depending on env)
const storage = require("../storage");

const router = express.Router();

/* ---------------------- file storage setup ---------------------- */
const uploadsRoot = path.join(__dirname, "..", "public", "uploads");
const postUploadsDir = path.join(uploadsRoot, "posts");
if (!fs.existsSync(postUploadsDir)) fs.mkdirSync(postUploadsDir, { recursive: true });

// In S3 mode we read file into memory and push to S3; in local mode we keep your disk storage
let upload;
if (storage.isS3) {
  upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB cap for posts
  });
} else {
    const diskStorage = multer.diskStorage({
      destination: (req, file, cb) => cb(null, postUploadsDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || "").slice(0, 10); // prevent very long ext
        const name = crypto.randomBytes(16).toString("hex") + ext;
        cb(null, name);
      },
    });
    upload = multer({ storage: diskStorage, limits: { fileSize: 50 * 1024 * 1024 } });
}

function buildPublicUrl(filename) {
  // served by express.static on /public (local-only)
  return `/uploads/posts/${filename}`;
}

// Helper to generate an S3 key for posts
function newKeyForPost(originalName) {
  const id =
    (crypto.randomUUID && crypto.randomUUID()) ||
    crypto.randomBytes(16).toString("hex");
  const ext = path.extname(originalName || "");
  return `posts/${id}${ext}`;
}

/**
 * POST /api/posts
 * Accepts multipart/form-data or JSON.
 * Fields: title, body, product_id, (optional media file under field name 'media')
 *
 * NOTE: In S3 mode we upload post media to the **public bucket** so existing
 * frontend `<img src={media_path}>` keeps working without presigned URLs.
 */
router.post("/", requireAuth, requireCreator, upload.single("media"), async (req, res) => {
  const creatorId = req.user.id;
  const { title, body } = req.body || {};
  const productId = parseInt(String(req.body.product_id || ""), 10);
  let media_path = null;

  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: "product_id required" });
  }

  if (req.file) {
    if (storage.isS3) {
      // Upload to PUBLIC bucket (simple to consume from the frontend)
      const key = newKeyForPost(req.file.originalname);
      const uploaded = await storage.uploadPublic({
        key,
        contentType: req.file.mimetype || "application/octet-stream",
        body: req.file.buffer,
      });
      // Prefer a full URL if driver provides it; otherwise build from key
      media_path = (storage.publicUrl && storage.publicUrl(uploaded.key)) || uploaded.url || uploaded.key;
    } else {
      // Local: keep your original disk behavior
      media_path = buildPublicUrl(req.file.filename);
    }
  } else if (req.body.media_path) {
    // allow direct media_path if already uploaded elsewhere
    media_path = req.body.media_path;
  }

  try {
    // Ensure the product exists and belongs to this creator
    const { rows: prodRows } = await db.query(
      `SELECT id, user_id AS creator_id, product_type, title, COALESCE(active, TRUE) AS active
         FROM products
        WHERE id = $1
        LIMIT 1`,
      [productId]
    );
    if (!prodRows.length) return res.status(404).json({ error: "Product not found" });
    if (String(prodRows[0].creator_id) !== String(creatorId)) {
      return res.status(403).json({ error: "Not your product" });
    }

    const product = prodRows[0];

    // ⛔️ Creators cannot post to an inactive membership product
    if (product.product_type === "membership" && !product.active) {
      return res.status(403).json({ error: "This membership is inactive; cannot add new posts." });
    }

    // Create post
    const { rows } = await db.query(
      `INSERT INTO posts (product_id, creator_id, title, body, media_path)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [productId, creatorId, title || null, body || null, media_path || null]
    );
    const post = rows[0];

    // Respond to client first
    res.status(201).json({ post });

    // NOTIFICATIONS (email + in-app) for members of THIS membership product
    if (product.product_type === "membership") {
      notifyPostToMembers({
        creatorId,
        productId,
        postId: post.id,
        title: post.title,
      }).catch(console.error);
    }
  } catch (e) {
    console.error("create post error:", e);
    res.status(500).json({ error: "Could not create post" });
  }
});

/**
 * PUT /api/posts/:id
 * Update title/body and optionally replace media (multipart with field 'media').
 */
router.put("/:id", requireAuth, requireCreator, upload.single("media"), async (req, res) => {
  const creatorId = req.user.id;
  const postId = parseInt(req.params.id, 10);
  if (Number.isNaN(postId)) return res.status(400).json({ error: "Invalid id" });
  const { title, body, media_remove } = req.body || {};

  try {
    const { rows: existingRows } = await db.query(
      `SELECT id, creator_id, media_path FROM posts WHERE id=$1 LIMIT 1`,
      [postId]
    );
    if (!existingRows.length) return res.status(404).json({ error: "Post not found" });
    if (String(existingRows[0].creator_id) !== String(creatorId)) {
      return res.status(403).json({ error: "Not your post" });
    }

    let media_path = existingRows[0].media_path;
    let oldLocalFilenameToDelete = null;
    let oldS3KeyToDelete = null;

    // If replacing or removing, mark old media for deletion
    const isRemoving = media_remove === "1" || media_remove === "true";
    const isReplacing = !!req.file;

    if ((isReplacing || isRemoving) && media_path) {
      if (String(media_path).startsWith("/uploads/posts/")) {
        // legacy local
        oldLocalFilenameToDelete = media_path.replace("/uploads/posts/", "");
      } else if (storage.isS3) {
        // S3: media_path might be a full URL or a key
        if (storage.keyFromPublicUrl) {
          oldS3KeyToDelete = storage.keyFromPublicUrl(media_path);
        } else {
          try {
            // crude fallback: take URL path after bucket host
            const u = new URL(media_path);
            oldS3KeyToDelete = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
          } catch {
            // or assume it was already a key
            oldS3KeyToDelete = media_path;
          }
        }
      }
    }

    // Apply changes for new media value
    if (req.file) {
      if (storage.isS3) {
        const key = newKeyForPost(req.file.originalname);
        const uploaded = await storage.uploadPublic({
          key,
          contentType: req.file.mimetype || "application/octet-stream",
          body: req.file.buffer,
        });
        media_path = (storage.publicUrl && storage.publicUrl(uploaded.key)) || uploaded.url || uploaded.key;
      } else {
        media_path = buildPublicUrl(req.file.filename);
      }
    } else if (isRemoving) {
      media_path = null;
    }

    const sets = [];
    const vals = [];
    let i = 1;
    if (title !== undefined) {
      sets.push(`title = $${i++}`);
      vals.push(title || null);
    }
    if (body !== undefined) {
      sets.push(`body = $${i++}`);
      vals.push(body || null);
    }
    if (isReplacing || isRemoving) {
      sets.push(`media_path = $${i++}`);
      vals.push(media_path);
    }

    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    vals.push(postId);

    const updated = await db.query(
      `UPDATE posts SET ${sets.join(", ")}, updated_at = NOW() WHERE id=$${i} RETURNING *`,
      vals
    );

    // Best-effort cleanup after DB update
    if (oldLocalFilenameToDelete) {
      const oldPath = path.join(postUploadsDir, oldLocalFilenameToDelete);
      fs.existsSync(oldPath) && fs.unlink(oldPath, () => {});
    }
    if (oldS3KeyToDelete) {
      try {
        await storage.deletePublic(oldS3KeyToDelete);
      } catch (e) {
        console.warn("Warning: failed to delete old S3 object", oldS3KeyToDelete, e?.message || e);
      }
    }

    return res.json({ post: updated.rows[0] });
  } catch (e) {
    console.error("update post error:", e);
    return res.status(500).json({ error: "Could not update post" });
  }
});

/**
 * GET /api/posts/product/:productId
 * - Fetch posts that belong to a specific product (membership product)
 * - Access allowed if requester is the creator OR has a valid membership
 * - Robust access:
 *    1) If user has *product-level* access -> return posts for that product (+ legacy NULL posts)
 *    2) Else if user has *creator-level* access to any of the creator's membership products
 *       -> return all posts by that creator (covers product-ID migrations)
 */
router.get("/product/:productId", requireAuth, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (Number.isNaN(productId)) return res.status(400).json({ error: "Invalid product id" });

  try {
    // Ensure product exists & get the owning creator
    const { rows: prod } = await db.query(
      `SELECT id, user_id, product_type, COALESCE(active, TRUE) AS active
         FROM products
        WHERE id=$1
        LIMIT 1`,
      [productId]
    );
    if (!prod.length) return res.status(404).json({ error: "Product not found" });

    const creatorId = prod[0].user_id;
    const userId = req.user.id;

    // If requester is the creator, allow (regardless of product.active)
    if (String(userId) === String(creatorId)) {
      const { rows } = await db.query(
        `SELECT p.*, cp.display_name, cp.profile_image
           FROM posts p
           JOIN creator_profiles cp ON cp.user_id = p.creator_id
          WHERE p.creator_id=$2
            AND (p.product_id = $1 OR p.product_id IS NULL)
          ORDER BY p.created_at DESC`,
        [productId, creatorId]
      );
      return res.json({ posts: rows });
    }

    // --- Non-creator: check access ---

    // 1) Product-level access (user is subscribed to this specific membership product)
    const { rows: prodAccess } = await db.query(
      `SELECT 1
         FROM memberships m
        WHERE m.buyer_id = $1
          AND m.product_id = $2
          AND (
                m.status IN ('active','trialing','past_due')
             OR (m.cancel_at_period_end = TRUE AND COALESCE(m.current_period_end, NOW()) >= NOW())
          )
          AND (m.current_period_end IS NULL OR NOW() <= m.current_period_end)
        LIMIT 1`,
      [userId, productId]
    );

    // 2) Creator-level access: user has an active membership to *any* product from this creator
    const { rows: creatorAccess } = await db.query(
      `SELECT 1
         FROM memberships m
         JOIN products    p ON p.id = m.product_id
        WHERE m.buyer_id = $1
          AND p.user_id  = $2
          AND p.product_type = 'membership'
          AND (
                m.status IN ('active','trialing','past_due')
             OR (m.cancel_at_period_end = TRUE AND COALESCE(m.current_period_end, NOW()) >= NOW())
          )
          AND (m.current_period_end IS NULL OR NOW() <= m.current_period_end)
        LIMIT 1`,
      [userId, creatorId]
    );

    if (!prodAccess.length && !creatorAccess.length) {
      return res.status(403).json({ error: "Membership required" });
    }

    // If user has product-level access, show posts scoped to this product (+ legacy)
    if (prodAccess.length) {
      const { rows } = await db.query(
        `SELECT p.*, cp.display_name, cp.profile_image
           FROM posts p
           JOIN creator_profiles cp ON cp.user_id = p.creator_id
          WHERE p.creator_id=$2
            AND (p.product_id = $1 OR p.product_id IS NULL)
          ORDER BY p.created_at DESC`,
        [productId, creatorId]
      );
      return res.json({ posts: rows });
    }

    // Else user has creator-level access (e.g., creator migrated products):
    // show *all* posts from this creator so the feed is not empty.
    const { rows } = await db.query(
      `SELECT p.*, cp.display_name, cp.profile_image
         FROM posts p
         JOIN creator_profiles cp ON cp.user_id = p.creator_id
        WHERE p.creator_id=$1
        ORDER BY p.created_at DESC`,
      [creatorId]
    );
    return res.json({ posts: rows });
  } catch (e) {
    console.error("get product posts error:", e);
    res.status(500).json({ error: "Could not fetch product posts" });
  }
});

/**
 * GET /api/posts/creator/:creatorId
 * - Members-only list of all posts for a creator (legacy endpoint moved to avoid route shadowing)
 */
router.get("/creator/:creatorId", requireAuth, async (req, res) => {
  const creatorId = parseInt(req.params.creatorId, 10);
  const userId = req.user.id;
  if (Number.isNaN(creatorId)) return res.status(400).json({ error: "Invalid id" });
  try {
    if (String(userId) !== String(creatorId)) {
      const { rows: access } = await db.query(
        `SELECT 1
           FROM memberships m
           JOIN products p ON p.id = m.product_id
          WHERE m.buyer_id=$1 AND p.user_id=$2
            AND p.product_type='membership'
            AND (
                  m.status IN ('active','trialing','past_due')
               OR (m.cancel_at_period_end = TRUE AND COALESCE(m.current_period_end, NOW()) >= NOW())
            )
            AND (m.current_period_end IS NULL OR NOW() <= m.current_period_end)
          LIMIT 1`,
        [userId, creatorId]
      );
      if (!access.length) return res.status(403).json({ error: "Membership required" });
    }
    const { rows } = await db.query(
      `SELECT * FROM posts WHERE creator_id=$1 ORDER BY created_at DESC`,
      [creatorId]
    );
    res.json({ posts: rows });
  } catch (e) {
    console.error("get creator posts error:", e);
    res.status(500).json({ error: "Could not fetch posts" });
  }
});

/**
 * DELETE /api/posts/:id
 * Remove a post owned by the creator.
 * - If media_path is a legacy local file (/uploads/posts/...), delete the file from disk.
 * - If media_path is an S3/Lightsail public URL or key, delete the object via storage.
 */
router.delete("/:id", requireAuth, requireCreator, async (req, res) => {
  const creatorId = req.user.id;
  const postId = parseInt(req.params.id, 10);
  if (Number.isNaN(postId)) return res.status(400).json({ error: "Invalid id" });
  try {
    const { rows: existing } = await db.query(
      `SELECT id, creator_id, media_path FROM posts WHERE id=$1 LIMIT 1`,
      [postId]
    );
    if (!existing.length) return res.status(404).json({ error: "Post not found" });
    if (String(existing[0].creator_id) !== String(creatorId)) {
      return res.status(403).json({ error: "Not your post" });
    }

    const media_path = existing[0].media_path;

    // Delete DB row first (idempotent; storage cleanup is best-effort)
    await db.query(`DELETE FROM posts WHERE id=$1`, [postId]);

    // Clean up storage:
    if (media_path) {
      if (String(media_path).startsWith("/uploads/posts/")) {
        // Legacy local file
        const filename = media_path.replace("/uploads/posts/", "");
        const fp = path.join(postUploadsDir, filename);
        fs.existsSync(fp) && fs.unlink(fp, () => {});
      } else if (storage.isS3) {
        // S3/Lightsail object in public bucket
        let key = null;
        if (storage.keyFromPublicUrl) {
          key = storage.keyFromPublicUrl(media_path);
        } else {
          try {
            const u = new URL(media_path);
            key = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
          } catch {
            key = media_path; // assume it's already a key
          }
        }
        if (key) {
          try {
            await storage.deletePublic(key);
          } catch (e) {
            console.warn("Warning: failed to delete S3 object", key, e?.message || e);
          }
        }
      }
    }

    return res.status(204).end();
  } catch (e) {
    console.error("delete post error:", e);
    return res.status(500).json({ error: "Could not delete post" });
  }
});

router.get("/inbox", (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
