const db = require("../db");

/** Core insert (JSON-stringify metadata, tolerate nulls) */
async function notify(userId, type, title, body, metadata = null) {
  const meta = metadata ? JSON.stringify(metadata) : null;
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, type, title, body, metadata)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [userId, String(type), title ?? null, body ?? null, meta]
  );
  return rows[0];
}

/** Mark some notifications as read (uses read_at, not is_read) */
async function markRead(userId, ids = []) {
  if (!ids.length) return { updated: 0 };
  const { rowCount } = await db.query(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE user_id = $1
        AND id = ANY($2::bigint[])
        AND read_at IS NULL`,
    [userId, ids]
  );
  return { updated: rowCount };
}

/** Mark all for user as read */
async function markAllRead(userId) {
  const { rowCount } = await db.query(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE user_id = $1
        AND read_at IS NULL`,
    [userId]
  );
  return { updated: rowCount };
}

/** Count unread */
async function countUnread(userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM notifications
      WHERE user_id = $1
        AND read_at IS NULL`,
    [userId]
  );
  return rows[0]?.count || 0;
}

/** List (optionally only unread) */
async function list(userId, { unread = false, limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT id, type, title, body, metadata, read_at, created_at
       FROM notifications
      WHERE user_id = $1 ${unread ? "AND read_at IS NULL" : ""}
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, Math.min(limit, 200), Math.max(offset, 0)]
  );
  return rows;
}

/** Fanout: JSON-stringify metadata for every row */
async function notifyMany(userIds = [], type, title, body, metadata = null) {
  if (!userIds.length) return 0;

  const values = [];
  const params = [];
  let i = 1;

  const metaJson = metadata ? JSON.stringify(metadata) : null;

  for (const uid of userIds) {
    params.push(uid, type, title ?? null, body ?? null, metaJson);
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
