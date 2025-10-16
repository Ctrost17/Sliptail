const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const db = require("../db");
const { requireAuth, requireCreator } = require("../middleware/auth");
const { notifyPostToMembers } = require("../utils/notify");
const mime = require("mime-types");
const { makeAndStorePoster } = require("../utils/videoPoster");
const os = require("os");

// Generic storage layer (local or S3)
const storage = require("../storage");
// For signing private reads (only used in S3 mode)
const s3storage = storage.isS3 ? require("../storage/s3") : null;

const router = express.Router();

/* ---------------------- file storage setup ---------------------- */
const uploadsRoot = path.join(__dirname, "..", "public", "uploads");
const postUploadsDir = path.join(uploadsRoot, "posts");
if (!fs.existsSync(postUploadsDir)) fs.mkdirSync(postUploadsDir, { recursive: true });

// In S3 mode we buffer in memory then push to S3; local mode keeps disk storage
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
      const ext = path.extname(file.originalname || "").slice(0, 10);
      const name = crypto.randomBytes(16).toString("hex") + ext;
      cb(null, name);
    },
  });
  upload = multer({ storage: diskStorage, limits: { fileSize: 50 * 1024 * 1024 } });
}

function buildLocalPublicUrl(filename) {
  return `/uploads/posts/${filename}`;
}

// Generate an S3 key for posts
function newKeyForPost(originalName) {
  const id = (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString("hex");
  const ext = path.extname(originalName || "");
  return `posts/${id}${ext}`;
}

function isVideoUpload(file) {
  const t =
    (file && file.mimetype) ||
    mime.lookup(file?.originalname || "") ||
    "";
  return String(t).startsWith("video/");
}

/* ---------------------- helpers: signed URLs --------------------- */

async function addSignedUrl(post) {
  if (!post) return post;

  // If there's nothing to sign, just pass through
  const out = { ...post };

  // For both drivers, storage.getPrivateUrl() gives a usable URL:
  // - LOCAL: returns "/uploads/..."
  // - S3:    returns a presigned https URL
  async function sign(field) {
    const v = post[field];
    if (!v) return null;
    try {
      return await storage.getPrivateUrl(v, { expiresIn: 60 });
    } catch (e) {
      console.warn(`sign ${field} failed:`, e?.message || e);
      return null;
    }
  }

  // Overwrite the fields your frontend already reads
  // (so the UI can keep using post.media_path / post.media_poster)
  if (post.media_path)    out.media_path    = await sign("media_path");
  if (post.media_poster)  out.media_poster  = await sign("media_poster");

  return out;
}

async function addSignedUrls(rows) {
  return Promise.all(rows.map(addSignedUrl));
}

/* ------------------------------- routes ------------------------------- */

/**
 * POST /api/posts
 * Accepts multipart/form-data or JSON.
 * Fields: title, body, product_id, (optional media file under field name 'media')
 *
 * S3 mode: upload to PRIVATE bucket, store S3 key in media_path.
 * Local mode: keep legacy disk path.
 */
router.post("/", requireAuth, requireCreator, upload.single("media"), async (req, res) => {
  const creatorId = req.user.id;
  const { title, body } = req.body || {};
  const productId = parseInt(String(req.body.product_id || ""), 10);
  let media_path = null;

  if (!Number.isFinite(productId)) {
    return res.status(400).json({ error: "product_id required" });
  }

  // Handle upload
  if (req.file) {
    if (storage.isS3) {
      // PRIVATE upload — save the KEY in DB
      const key = newKeyForPost(req.file.originalname);
      await storage.uploadPrivate({
        key,
        contentType: req.file.mimetype || "application/octet-stream",
        body: req.file.buffer,
      });
      media_path = key; // store KEY (not URL)
    } else {
      // Local: keep on disk and store a public path
      media_path = buildLocalPublicUrl(req.file.filename);
    }
  } else if (req.body.media_path) {
    // If caller already provided a path/key (advanced use)
    media_path = req.body.media_path;
  }

  try {
    // Ensure product exists and belongs to this creator
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

    if (product.product_type === "membership" && !product.active) {
      return res.status(403).json({ error: "This membership is inactive; cannot add new posts." });
    }

    // Create post (store media_path: disk URL in local mode, S3 KEY in S3 mode)
    const { rows } = await db.query(
      `INSERT INTO posts (product_id, creator_id, title, body, media_path)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [productId, creatorId, title || null, body || null, media_path || null]
    );

    // If a video was uploaded, make a poster now and save it
    let postRow = rows[0];
    if (req.file && isVideoUpload(req.file)) {
      try {
        // Build a temp absolute path to feed ffmpeg, depending on driver
        let absInputPath;
        let tmpPath = null;

        if (storage.isS3) {
          // We uploaded from memory; write the buffer to tmp for ffmpeg
          const tmpExt = path.extname(req.file.originalname || "") || ".bin";
          tmpPath = path.join(os.tmpdir(), `postvid-${postRow.id}-${Date.now()}${tmpExt}`);
          await fs.promises.writeFile(tmpPath, req.file.buffer);
          absInputPath = tmpPath;
        } else {
          // Disk mode already put the file on disk
          absInputPath = req.file.path; // multer's diskStorage gives us this
        }

        // Store poster alongside post media: e.g. "posts/<postId>/poster.jpg"
        const posterKey = `posts/${postRow.id}/poster.jpg`;
        const storedPosterKeyOrPath = await makeAndStorePoster(absInputPath, posterKey);

        // Save on the post
        const { rows: upd } = await db.query(
          `UPDATE posts SET media_poster = $1 WHERE id = $2 RETURNING *`,
          [storedPosterKeyOrPath, postRow.id]
        );
        postRow = upd[0];

        // Cleanup tmp file if we created one
        if (tmpPath) { try { fs.unlink(tmpPath, () => {}); } catch {}
        }
      } catch (e) {
        console.warn("poster generation failed:", e?.message || e);
      }
    }

    const postWithUrl = await addSignedUrl(rows[0]);
    res.status(201).json({ post: postWithUrl });

    // Notify members for membership products
    if (product.product_type === "membership") {
      notifyPostToMembers({
        creatorId,
        productId,
        postId: rows[0].id,
        title: rows[0].title,
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
 * S3 mode: replace/delete in PRIVATE bucket. Local: keep disk files.
 */
router.put("/:id", requireAuth, requireCreator, upload.single("media"), async (req, res) => {
  const creatorId = req.user.id;
  const postId = parseInt(req.params.id, 10);
  if (Number.isNaN(postId)) return res.status(400).json({ error: "Invalid id" });
  const { title, body, media_remove } = req.body || {};

  try {
    const { rows: existingRows } = await db.query(
      `SELECT id, creator_id, media_path, media_poster FROM posts WHERE id=$1 LIMIT 1`,
      [postId]
    );
    if (!existingRows.length) return res.status(404).json({ error: "Post not found" });
    if (String(existingRows[0].creator_id) !== String(creatorId)) {
      return res.status(403).json({ error: "Not your post" });
    }

    let media_path = existingRows[0].media_path;
    let oldLocalFilenameToDelete = null;
    let oldS3KeyToDelete = null;

    const isRemoving = media_remove === "1" || media_remove === "true";
    const isReplacing = !!req.file;

    // mark old media for cleanup
    if ((isReplacing || isRemoving) && media_path) {
      if (!storage.isS3 && String(media_path).startsWith("/uploads/posts/")) {
        oldLocalFilenameToDelete = media_path.replace("/uploads/posts/", "");
      } else if (storage.isS3) {
        // In S3 mode media_path stores the KEY
        oldS3KeyToDelete = media_path;
      }
    }
    if ((isReplacing || isRemoving) && media_poster) {
      if (!storage.isS3 && String(media_poster).startsWith("/uploads/posts/")) {
        oldPosterLocalToDelete = media_poster.replace("/uploads/posts/", "");
      } else if (storage.isS3) {
        oldPosterS3KeyToDelete = media_poster;
      }
    }

    // apply new media
    if (req.file) {
      if (storage.isS3) {
        const key = newKeyForPost(req.file.originalname);
        await storage.uploadPrivate({
          key,
          contentType: req.file.mimetype || "application/octet-stream",
          body: req.file.buffer,
        });
        media_path = key;
      } else {
        media_path = buildLocalPublicUrl(req.file.filename);
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
        if (isReplacing || isRemoving) {
      sets.push(`media_poster = $${i++}`);
      vals.push(media_poster);
    }


    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    vals.push(postId);

    const updated = await db.query(
      `UPDATE posts SET ${sets.join(", ")}, updated_at = NOW() WHERE id=$${i} RETURNING *`,
      vals
    );

      // Decide new poster value based on new/removed media
  if (req.file) {
    if (isVideoUpload(req.file)) {
      try {
        let absInputPath;
        let tmpPath = null;

        if (storage.isS3) {
          const tmpExt = path.extname(req.file.originalname || "") || ".bin";
          tmpPath = path.join(os.tmpdir(), `postvid-${postId}-${Date.now()}${tmpExt}`);
          await fs.promises.writeFile(tmpPath, req.file.buffer);
          absInputPath = tmpPath;
        } else {
          absInputPath = req.file.path;
        }

        const posterKey = `posts/${postId}/poster.jpg`;
        media_poster = await makeAndStorePoster(absInputPath, posterKey);

        if (tmpPath) { try { fs.unlink(tmpPath, () => {}); } catch {} }
      } catch (e) {
        console.warn("poster generation (update) failed:", e?.message || e);
        media_poster = null; // fall back to none if generation fails
      }
    } else {
      // Replaced with a non-video; drop any old poster
      media_poster = null;
    }
  } else if (isRemoving) {
    media_poster = null;
  } 
    // cleanup best-effort
    if (oldLocalFilenameToDelete) {
      const oldPath = path.join(postUploadsDir, oldLocalFilenameToDelete);
      fs.existsSync(oldPath) && fs.unlink(oldPath, () => {});
    }
    if (oldS3KeyToDelete) {
      try {
        await storage.deletePrivate(oldS3KeyToDelete);
      } catch (e) {
        console.warn("Warning: failed to delete old private S3 object", oldS3KeyToDelete, e?.message || e);
      }
    }
    if (oldPosterLocalToDelete) {
      const oldPosterPath = path.join(postUploadsDir, oldPosterLocalToDelete);
      fs.existsSync(oldPosterPath) && fs.unlink(oldPosterPath, () => {});
    }
    if (oldPosterS3KeyToDelete) {
      try { await storage.deletePrivate(oldPosterS3KeyToDelete); }
      catch (e) { console.warn("Warning: failed to delete old private S3 poster", oldPosterS3KeyToDelete, e?.message || e); }
    }

    const postWithUrl = await addSignedUrl(updated.rows[0]);
    return res.json({ post: postWithUrl });
  } catch (e) {
    console.error("update post error:", e);
    return res.status(500).json({ error: "Could not update post" });
  }
});


/**
 * GET /api/posts/product/:productId
 * Membership access logic unchanged, but we now attach a signed `media_url` when in S3 mode.
 */
router.get("/product/:productId", requireAuth, async (req, res) => {
  const productId = parseInt(req.params.productId, 10);
  if (Number.isNaN(productId)) return res.status(400).json({ error: "Invalid product id" });

  try {
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

    // creator sees all
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
      const withUrls = await addSignedUrls(rows);
      return res.json({ posts: withUrls });
    }

    // product-level access?
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

    // creator-level access to any membership?
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
      const withUrls = await addSignedUrls(rows);
      return res.json({ posts: withUrls });
    }

    const { rows } = await db.query(
      `SELECT p.*, cp.display_name, cp.profile_image
         FROM posts p
         JOIN creator_profiles cp ON cp.user_id = p.creator_id
        WHERE p.creator_id=$1
        ORDER BY p.created_at DESC`,
      [creatorId]
    );
    const withUrls = await addSignedUrls(rows);
    return res.json({ posts: withUrls });
  } catch (e) {
    console.error("get product posts error:", e);
    res.status(500).json({ error: "Could not fetch product posts" });
  }
});

/**
 * GET /api/posts/creator/:creatorId
 * Members-only list of all posts for a creator; attach signed URLs when needed.
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
    const withUrls = await addSignedUrls(rows);
    res.json({ posts: withUrls });
  } catch (e) {
    console.error("get creator posts error:", e);
    res.status(500).json({ error: "Could not fetch posts" });
  }
});

/**
 * DELETE /api/posts/:id
 * Remove a post owned by the creator.
 * - Local: delete disk file
 * - S3: delete from PRIVATE bucket (key stored in media_path)
 */
router.delete("/:id", requireAuth, requireCreator, async (req, res) => {
  const creatorId = req.user.id;
  const postId = parseInt(req.params.id, 10);
  if (Number.isNaN(postId)) return res.status(400).json({ error: "Invalid id" });
  try {
    const { rows: existing } = await db.query(
      `SELECT id, creator_id, media_path, media_poster FROM posts WHERE id=$1 LIMIT 1`,
      [postId]
    );
    if (!existing.length) return res.status(404).json({ error: "Post not found" });
    if (String(existing[0].creator_id) !== String(creatorId)) {
      return res.status(403).json({ error: "Not your post" });
    }

    const media_path = existing[0].media_path;

    // Delete DB row first
    await db.query(`DELETE FROM posts WHERE id=$1`, [postId]);

    // Cleanup storage best-effort
    if (media_path) {
      if (!storage.isS3 && String(media_path).startsWith("/uploads/posts/")) {
        const filename = media_path.replace("/uploads/posts/", "");
        const fp = path.join(postUploadsDir, filename);
        fs.existsSync(fp) && fs.unlink(fp, () => {});
      } else if (storage.isS3) {
        try {
          await storage.deletePrivate(media_path); // media_path is the KEY
        } catch (e) {
          console.warn("Warning: failed to delete private S3 object", media_path, e?.message || e);
        }
      }
    }
      const poster = existing[0].media_poster;
      if (poster) {
        if (!storage.isS3 && String(poster).startsWith("/uploads/posts/")) {
          const p = poster.replace("/uploads/posts/", "");
          const fp = path.join(postUploadsDir, p);
          fs.existsSync(fp) && fs.unlink(fp, () => {});
        } else if (storage.isS3) {
          try { await storage.deletePrivate(poster); }
          catch (e) { console.warn("Warning: failed to delete private S3 poster", poster, e?.message || e); }
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
