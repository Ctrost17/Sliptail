const express = require("express");
const db = require("../db");
const { requireAuth, requireCreator } = require("../middleware/auth");
const { notifyPostToMembers } = require("../utils/notify");

const router = express.Router();

/**
 * POST /api/posts
 * Body: { title, body, media_path }
 * - Creator creates a post for their members
 */
router.post("/", requireAuth, requireCreator, async (req, res) => {
  const creatorId = req.user.id;
  const { title, body, media_path } = req.body || {};
  try {
    const { rows } = await db.query(
      `INSERT INTO posts (creator_id, title, body, media_path)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [creatorId, title || null, body || null, media_path || null]
    );
    res.status(201).json({ post: rows[0] }); 
  // fire-and-forget: notify all active members of this creator
    notifyPostToMembers({
      creatorId,
      postId: rows[0].id,
      title: rows[0].title
      }).catch(console.error);
  }
      catch (e) {
    console.error("create post error:", e);
    res.status(500).json({ error: "Could not create post" });
  }
});

/**
 * GET /api/posts/:creatorId
 * - Members-only: must have active access to the creator
 */
router.get("/:creatorId", requireAuth, async (req, res) => {
  const creatorId = parseInt(req.params.creatorId, 10);
  const userId = req.user.id;

  try {
    // membership access check
    const { rows: access } = await db.query(
      `SELECT 1
         FROM memberships
        WHERE buyer_id=$1 AND creator_id=$2
          AND status IN ('active','trialing')
          AND NOW() <= current_period_end
        LIMIT 1`,
      [userId, creatorId]
    );
    if (!access.length) {
      return res.status(403).json({ error: "Membership required" });
    }

    const { rows } = await db.query(
      `SELECT * FROM posts
        WHERE creator_id=$1
        ORDER BY created_at DESC`,
      [creatorId]
    );
    res.json({ posts: rows });
  } catch (e) {
    console.error("get posts error:", e);
    res.status(500).json({ error: "Could not fetch posts" });
  }
});

module.exports = router;