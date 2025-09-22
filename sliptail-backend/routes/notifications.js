const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

/**
 * Lightweight unread count (for navbar/burger menu badge)
 * GET /api/notifications/unread-count
 * -> { unread: number }
 */
router.get("/unread-count", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS unread
         FROM notifications
        WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );
    res.json({ unread: rows[0]?.unread ?? 0 });
  } catch (e) {
    console.error("notifications unread-count error:", e?.message || e);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

/**
 * List my notifications (newest first)
 * GET /api/notifications?limit=20&offset=0&unread_only=true
 * -> { notifications: [...], unread: number }
 */
router.get("/", requireAuth, async (req, res) => {
  const rawLimit = parseInt(req.query.limit || "20", 10);
  const rawOffset = parseInt(req.query.offset || "0", 10);
  const limit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 20, 100);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

  const uo = String(req.query.unread_only || "").toLowerCase();
  const unreadOnly = uo === "true" || uo === "1" || uo === "yes";

  try {
    const where = [`user_id = $1`];
    const params = [req.user.id, limit, offset];

    if (unreadOnly) where.push(`read_at IS NULL`);

    const { rows } = await db.query(
      `SELECT id, type, title, body, metadata, read_at, created_at
         FROM notifications
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      params
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS unread
         FROM notifications
        WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );

    res.json({ notifications: rows, unread: countRows[0]?.unread ?? 0 });
  } catch (e) {
    console.error("notifications list error:", e?.message || e);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

/**
 * Mark one notification as read
 * POST /api/notifications/:id/read
 * -> { success: true, id, read_at }
 */
router.post("/:id/read", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

  try {
    const { rows } = await db.query(
      `UPDATE notifications
          SET read_at = NOW()
        WHERE id = $1 AND user_id = $2 AND read_at IS NULL
        RETURNING id, read_at`,
      [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, id, read_at: rows[0].read_at });
  } catch (e) {
    console.error("notifications mark read error:", e?.message || e);
    res.status(500).json({ error: "Failed to mark notification as read" });
  }
});

/**
 * Mark all as read
 * POST /api/notifications/read-all
 * -> { success: true }
 */
router.post("/read-all", requireAuth, async (req, res) => {
  try {
    await db.query(
      `UPDATE notifications
          SET read_at = NOW()
        WHERE user_id = $1 AND read_at IS NULL`,
      [req.user.id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("notifications read-all error:", e?.message || e);
    res.status(500).json({ error: "Failed to mark all as read" });
  }
});

module.exports = router;
