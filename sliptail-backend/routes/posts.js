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
const { ensureFastStart } = require("../utils/faststart");

// Generic storage layer (local or S3)
const storage = require("../storage");

// ---- add this helper right here ----
const TMP_DIR = os.tmpdir();
async function uploadBufferSmart({ key, contentType, buffer }) {
  // For large payloads, write to a tmp file and let storage.js stream it.
  const BIG = 8 * 1024 * 1024; // 8MB threshold
  if (buffer.length <= BIG) {
    return storage.uploadPrivate({ key, contentType, body: buffer });
  }
  const tmpPath = path.join(TMP_DIR, `post-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.promises.writeFile(tmpPath, buffer);
  try {
    return await storage.uploadPrivate({ key, contentType, body: tmpPath });
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

const router = express.Router();

/* ---------------------- file storage setup ---------------------- */
const uploadsRoot = path.join(__dirname, "..", "public", "uploads");
const postUploadsDir = path.join(uploadsRoot, "posts");
if (!fs.existsSync(postUploadsDir)) fs.mkdirSync(postUploadsDir, { recursive: true });

// In S3 mode we buffer in memory then push to S3; local mode keeps disk storage
let upload;
if (storage.isS3) {
  const s3TmpStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "");
      cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  });
  upload = multer({
    storage: s3TmpStorage,
    limits: { fileSize: 50 * 1024 * 1024 }, // keep your 50MB for posts (or raise if you want)
  });
} else {
  // (keep your existing local disk storage for non-S3)
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

// helper: accept raw keys, already-signed URLs, or {key:"..."} legacy shapes
function normalizeKeyOrUrl(v) {
  if (!v) return null;
  if (typeof v === "string") {
    if (/^https?:\/\//i.test(v)) return v;     // already a URL
    try { const j = JSON.parse(v); if (j?.key) return j.key; } catch {}
    return v;                                   // assume raw key
  }
  if (typeof v === "object" && v.key) return v.key;
  return String(v);
}

function isPostsKey(raw) {
  return typeof raw === "string" && raw.replace(/^\/+/, "").startsWith("posts/");
}

async function addSignedUrl(post) {
  if (!post) return post;
  const out = { ...post };

  async function sign(field) {
    const raw = normalizeKeyOrUrl(post[field]);
    if (!raw) return null;

    // Already a full URL? Don't re-sign.
    if (/^https?:\/\//i.test(raw)) return raw;

    let url;
    try {
      // storage.getPrivateUrl will CloudFront-sign posts/* and S3-presign everything else
      url = await storage.getPrivateUrl(raw, { expiresIn: 3600 });
    } catch (e) {
      console.warn(`sign ${field} failed:`, e?.message || e);
      return null;
    }

    // Add a tiny cache-buster ONLY for posts/* (CloudFront). Do NOT touch S3-presigned links.
    if (isPostsKey(raw)) {
      const v = Math.floor(new Date(post.updated_at || post.created_at || Date.now()).getTime() / 1000);
      url += (url.includes("?") ? "&" : "?");
    }
    return url;
  }

  if (post.media_path)   out.media_path   = await sign("media_path");
  if (post.media_poster) out.media_poster = await sign("media_poster");
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

  // Handle upload (multipart) or direct path/key
  if (req.file) {
    if (storage.isS3) {
      const key = newKeyForPost(req.file.originalname);
      await storage.uploadPrivate({
        key,
        contentType: req.file.mimetype || "application/octet-stream",
        body: req.file.path,
      });
      await fs.promises.unlink(req.file.path).catch(() => {});
      media_path = key;          // S3 KEY in DB
    } else {
      media_path = buildLocalPublicUrl(req.file.filename); // local path
    }
  } else if (req.body.media_path) {
    media_path = req.body.media_path; // presigned flow sends this
  }

  try {
    // Product ownership checks (unchanged)...
    const { rows: prodRows } = await db.query(
      `SELECT id, user_id AS creator_id, product_type, title, COALESCE(active, TRUE) AS active
         FROM products WHERE id = $1 LIMIT 1`,
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

    // 1) create post
    const { rows } = await db.query(
      `INSERT INTO posts (product_id, creator_id, title, body, media_path)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [productId, creatorId, title || null, body || null, media_path || null]
    );

    // 2) reply immediately (fast)
    const postRow = rows[0];
    const postWithUrl = await addSignedUrl(postRow);
    res.status(201).json({ post: postWithUrl });

    // 3) background work: generate poster (for videos) & notify
    setImmediate(async () => {
      try {
        // decide if it’s a video by simple extension check when we don't have req.file
        const isVideoByKey =
          media_path &&
          /\.(mp4|webm|mov|m4v)$/i.test(String(media_path).split("?")[0]);

        if ((req.file && isVideoUpload(req.file)) || (!req.file && isVideoByKey)) {
          // 1) Poster
          const posterResult = await makeAndStorePoster(media_path, { private: true });
          const posterValue = posterResult?.key || posterResult;
          if (posterValue) {
            await db.query(
              `UPDATE posts SET media_poster = $1 WHERE id = $2`,
              [posterValue, postRow.id]
            );
          }

          // 2) Fast-start MP4 (lossless remux)
          if (/\.mp4$/i.test(String(media_path))) {
            await ensureFastStart(media_path);
            // bump updated_at so clients naturally pick up the new edge object
            await db.query(`UPDATE posts SET updated_at = NOW() WHERE id = $1`, [postRow.id]);
          }
        }
      } catch (e) {
        console.warn("post-processing failed:", e?.message || e);
      }

      try {
        if (product.product_type === "membership") {
          await notifyPostToMembers({
            creatorId,
            productId,
            postId: postRow.id,
            title: postRow.title,
          });
        }
      } catch (e) {
        console.warn("notify failed:", e?.message || e);
      }
    });

  } catch (e) {
    console.error("create post error:", e);
    if (!res.headersSent) res.status(500).json({ error: "Could not create post" });
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
    let media_poster = existingRows[0].media_poster;
    let oldLocalFilenameToDelete = null;
    let oldS3KeyToDelete = null;
    let oldPosterLocalToDelete = null;   // <-- add
    let oldPosterS3KeyToDelete = null;   // <-- add

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
          body: req.file.path,   // <-- PATH
        });
        await fs.promises.unlink(req.file.path).catch(() => {});
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

    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    vals.push(postId);

    const updated = await db.query(
      `UPDATE posts SET ${sets.join(", ")}, updated_at = NOW() WHERE id=$${i} RETURNING *`,
      vals
    );

    // ----- Decide new poster value based on new/removed media, and persist it -----
    let finalRow = updated.rows[0];

    if (req.file) {
      if (isVideoUpload(req.file)) {
        try {
          // makeAndStorePoster reads from storage (media_path key) and generates a poster
          const storedPoster = await makeAndStorePoster(media_path, { private: true });
          const posterValue = storedPoster?.key || storedPoster;

          if (posterValue) {
            // Persist the fresh poster
            const { rows: upd2 } = await db.query(
              `UPDATE posts SET media_poster = $1, updated_at = NOW() WHERE id=$2 RETURNING *`,
              [posterValue, postId]
            );
            finalRow = upd2[0];
          }
        } catch (e) {
          console.warn("poster generation (update) failed:", e?.message || e);
          // If generation fails, drop any stale poster so UI doesn’t show a broken one
          const { rows: upd2 } = await db.query(
            `UPDATE posts SET media_poster = NULL, updated_at = NOW() WHERE id=$1 RETURNING *`,
            [postId]
          );
          finalRow = upd2[0];
        }
      } else {
        // Replaced with a non-video; drop any old poster
        const { rows: upd2 } = await db.query(
          `UPDATE posts SET media_poster = NULL, updated_at = NOW() WHERE id=$1 RETURNING *`,
          [postId]
        );
        finalRow = upd2[0];
      }
    } else if (isRemoving) {
      // Explicit removal
      const { rows: upd2 } = await db.query(
        `UPDATE posts SET media_poster = NULL, updated_at = NOW() WHERE id=$1 RETURNING *`,
        [postId]
      );
      finalRow = upd2[0];
    }
  
      // If a new file was uploaded and it's an MP4, do fast-start and bump updated_at
      if (req.file && /\.mp4$/i.test(String(media_path))) {
        try {
          await ensureFastStart(media_path);
          const { rows: upd3 } = await db.query(
            `UPDATE posts SET updated_at = NOW() WHERE id = $1 RETURNING *`,
            [postId]
          );
          if (upd3?.[0]) finalRow = upd3[0];
        } catch (e) {
          console.warn("fast-start (update) failed:", e?.message || e);
        }
      }

    const postWithUrl = await addSignedUrl(finalRow);
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
        const posterKey = normalizeKeyOrUrl(poster);
        if (!storage.isS3 && String(posterKey).startsWith("/uploads/posts/")) {
          const p = posterKey.replace("/uploads/posts/", "");
          const fp = path.join(postUploadsDir, p);
          fs.existsSync(fp) && fs.unlink(fp, () => {});
        } else if (storage.isS3) {
          try { await storage.deletePrivate(posterKey); }
          catch (e) { console.warn("Warning: failed to delete old private S3 poster", posterKey, e?.message || e); }
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
