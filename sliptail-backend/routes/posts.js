const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const db = require("../db");
const { requireAuth, requireCreator } = require("../middleware/auth");
const { notifyPostToMembers } = require("../utils/notify");

const router = express.Router();

/* ---------------------- file storage setup ---------------------- */
const uploadsRoot = path.join(__dirname, "..", "public", "uploads");
const postUploadsDir = path.join(uploadsRoot, "posts");
if (!fs.existsSync(postUploadsDir)) fs.mkdirSync(postUploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, postUploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").slice(0, 10); // prevent very long ext
    const name = crypto.randomBytes(16).toString("hex") + ext;
    cb(null, name);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB cap for posts

function buildPublicUrl(filename) {
  // served by express.static on /public
  return `/uploads/posts/${filename}`;
}

/**
 * POST /api/posts
 * Accepts multipart/form-data or JSON.
 * Fields: title, body, product_id, (optional media file under field name 'media')
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
    media_path = buildPublicUrl(req.file.filename);
  } else if (req.body.media_path) {
    // allow direct media_path if already uploaded elsewhere
    media_path = req.body.media_path;
  }

  try {
    // Ensure the product exists and belongs to this creator
    const { rows: prodRows } = await db.query(
      `SELECT id, user_id AS creator_id, product_type, title
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

    // Notify only members of THIS membership product (no duplicates)
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
    let oldFilenameToDelete = null;

    if (req.file) {
      if (media_path && media_path.startsWith("/uploads/posts/")) {
        oldFilenameToDelete = media_path.replace("/uploads/posts/", "");
      }
      media_path = buildPublicUrl(req.file.filename);
    } else if (media_remove === "1" || media_remove === "true") {
      if (media_path && media_path.startsWith("/uploads/posts/")) {
        oldFilenameToDelete = media_path.replace("/uploads/posts/", "");
      }
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
    if (req.file || media_remove === "1" || media_remove === "true") {
      sets.push(`media_path = $${i++}`);
      vals.push(media_path);
    }

    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    vals.push(postId);

    const { rows } = await db.query(
      `UPDATE posts SET ${sets.join(", ")}, updated_at = NOW() WHERE id=$${i} RETURNING *`,
      vals
    );

    if (oldFilenameToDelete) {
      const oldPath = path.join(postUploadsDir, oldFilenameToDelete);
      fs.existsSync(oldPath) && fs.unlink(oldPath, () => {});
    }

    return res.json({ post: rows[0] });
  } catch (e) {
    console.error("update post error:", e);
    return res.status(500).json({ error: "Could not update post" });
  }
});

/**
 * GET /api/posts/product/:productId
 * - Fetch posts that belong to a specific product (membership product)
 * - Access allowed if requester is the creator OR has an active membership to that creator
 */
router.get("/product/:productId", requireAuth, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (Number.isNaN(productId)) return res.status(400).json({ error: "Invalid product id" });
  try {
    // Ensure product exists & get creator owning it
    const { rows: prod } = await db.query(
      `SELECT id, user_id FROM products WHERE id=$1 LIMIT 1`,
      [productId]
    );
    if (!prod.length) return res.status(404).json({ error: "Product not found" });
    const creatorId = prod[0].user_id;
    const userId = req.user.id;

    // If not the creator, verify membership access
    if (String(userId) !== String(creatorId)) {
      const { rows: access } = await db.query(
        `SELECT 1 FROM memberships
          WHERE buyer_id=$1 AND creator_id=$2
            AND status IN ('active','trialing')
            AND NOW() <= current_period_end
            AND cancel_at_period_end = FALSE
          LIMIT 1`,
        [userId, creatorId]
      );
      if (!access.length) return res.status(403).json({ error: "Membership required" });
    }

    // Fetch posts for this creator that either belong to this product or are legacy (NULL product_id)
    const { rows } = await db.query(
      `SELECT p.*, cp.display_name, cp.profile_image
         FROM posts p
         JOIN creator_profiles cp ON cp.user_id = p.creator_id
        WHERE p.creator_id=$2
          AND (p.product_id = $1 OR p.product_id IS NULL)
        ORDER BY p.created_at DESC`,
      [productId, creatorId]
    );

    res.json({ posts: rows });
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
        `SELECT 1 FROM memberships
          WHERE buyer_id=$1 AND creator_id=$2
            AND status IN ('active','trialing')
            AND NOW() <= current_period_end
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
 * Remove a post owned by the creator. Also deletes media file if stored locally under /uploads/posts.
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
    await db.query(`DELETE FROM posts WHERE id=$1`, [postId]);
    if (media_path && media_path.startsWith("/uploads/posts/")) {
      const filename = media_path.replace("/uploads/posts/", "");
      const fp = path.join(postUploadsDir, filename);
      if (fs.existsSync(fp)) fs.unlink(fp, () => {});
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