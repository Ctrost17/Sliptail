const db = require("../db");

/** Core insert */
async function notify(userId, type, title, body, metadata = {}) {
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, type, title, body, metadata)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [userId, String(type), String(title), String(body), metadata]
  );
  return rows[0];
}

/** Mark some notifications as read (only current user’s) */
async function markRead(userId, ids = []) {
  if (!ids.length) return { updated: 0 };
  const { rowCount } = await db.query(
    `UPDATE notifications
        SET is_read = TRUE, read_at = NOW()
      WHERE user_id = $1 AND id = ANY($2::bigint[]) AND is_read = FALSE`,
    [userId, ids]
  );
  return { updated: rowCount };
}

/** Mark all for user as read */
async function markAllRead(userId) {
  const { rowCount } = await db.query(
    `UPDATE notifications
        SET is_read = TRUE, read_at = NOW()
      WHERE user_id = $1 AND is_read = FALSE`,
    [userId]
  );
  return { updated: rowCount };
}

/** Count unread */
async function countUnread(userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM notifications
      WHERE user_id = $1 AND is_read = FALSE`,
    [userId]
  );
  return rows[0]?.count || 0;
}

/** List (optionally only unread) */
async function list(userId, { unread = false, limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT id, type, title, body, metadata, is_read, created_at, read_at
       FROM notifications
      WHERE user_id = $1 ${unread ? "AND is_read = FALSE" : ""}
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, Math.min(limit, 200), Math.max(offset, 0)]
  );
  return rows;
}

/** Helper: fanout to many users (bulk) */
async function notifyMany(userIds = [], type, title, body, metadata = {}) {
  if (!userIds.length) return 0;
  const values = [];
  const params = [];
  let i = 1;
  for (const uid of userIds) {
    params.push(uid, type, title, body, metadata);
    values.push(`($${i++},$${i++},$${i++},$${i++},$${i++})`);
  }
  const sql = `
    INSERT INTO notifications (user_id, type, title, body, metadata)
    VALUES ${values.join(",")}
  `;
  const r = await db.query(sql, params);
  return r.rowCount || 0;
}

module.exports = {
  notify,
  notifyMany,
  markRead,
  markAllRead,
  countUnread,
  list,
};