const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const bcrypt = require("bcrypt");

const router = express.Router();

/**
 * ------------------------- ACCOUNT PROFILE -------------------------
 * GET my account profile basics
 * Returns: { email, username, has_password, email_verified }
 */
router.get("/profile", requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT email, username,
            (password_hash IS NOT NULL) AS has_password,
            COALESCE(email_verified, FALSE) AS email_verified
     FROM users
     WHERE id=$1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "User not found" });
  res.json(rows[0]);
});

/**
 * PUT update email and/or username
 * Body: { email?: string, username?: string | null }
 * - Validates email format if provided
 * - Enforces uniqueness (case-insensitive) for email and username
 * - If email changes, clears email verification flags
 * Returns: { email, username, email_verified }
 */
router.put("/profile", requireAuth, async (req, res) => {
  const { email, username } = req.body ?? {};

  const updates = [];
  const params = [req.user.id];
  let idx = 2;

  // Validate & collect fields
  if (typeof email !== "undefined") {
    const trimmed = String(email).trim();
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(trimmed)) {
      return res.status(400).json({ error: "Invalid email format" });
    }
    // Set email and reset verification flags
    updates.push(`email = $${idx++}`);
    params.push(trimmed);
    updates.push(`email_verified = FALSE`);
    updates.push(`email_verified_at = NULL`);
  }

  if (typeof username !== "undefined") {
    // Allow clearing username (make optional)
    const u =
      username === "" || username === undefined || username === null
        ? null
        : String(username).trim();
    updates.push(`username = $${idx++}`);
    params.push(u);
  }

  if (!updates.length) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  try {
    // Uniqueness checks
    if (typeof email !== "undefined") {
      const { rows: eRows } = await db.query(
        `SELECT 1 FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2 LIMIT 1`,
        [String(email).trim(), req.user.id]
      );
      if (eRows.length) return res.status(409).json({ error: "Email already in use" });
    }
    if (typeof username !== "undefined" && username) {
      const { rows: uRows } = await db.query(
        `SELECT 1 FROM users WHERE LOWER(username)=LOWER($1) AND id<>$2 LIMIT 1`,
        [String(username).trim(), req.user.id]
      );
      if (uRows.length) return res.status(409).json({ error: "Username already taken" });
    }

    const sql = `
      UPDATE users
      SET ${updates.join(", ")}
      WHERE id=$1
      RETURNING email, username, COALESCE(email_verified, FALSE) AS email_verified
    `;
    const { rows } = await db.query(sql, params);
    res.json(rows[0]);
  } catch (err) {
    console.error("PUT /profile error", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

/**
 * PUT update password
 * Body: { current_password?: string, new_password: string }
 * - If user already has a password, require and verify current_password
 * - Enforce min length 8 for new password
 */
router.put("/password", requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body ?? {};
  if (!new_password || String(new_password).length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters" });
  }

  const { rows } = await db.query(
    `SELECT password_hash FROM users WHERE id=$1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "User not found" });

  const hasHash = !!rows[0].password_hash;

  // If a password exists, verify current_password
  if (hasHash) {
    if (!current_password) {
      return res.status(400).json({ error: "Current password is required" });
    }
    const ok = await bcrypt.compare(String(current_password), rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: "Current password is incorrect" });
  }

  const newHash = await bcrypt.hash(String(new_password), 12);
  await db.query(
    `UPDATE users SET password_hash=$1 WHERE id=$2`,
    [newHash, req.user.id]
  );

  res.json({ ok: true });
});

/**
 * ------------------------- NOTIFICATIONS (existing) -------------------------
 * GET my notification prefs
 */
router.get("/notifications", requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT
       notify_post,
       notify_membership_expiring,
       notify_purchase,
       notify_request_completed,
       notify_new_request,
       notify_product_sale
     FROM users WHERE id=$1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "User not found" });
  res.json(rows[0]);
});

/**
 * PUT update some/all notification toggles
 * Body: any subset of the boolean fields above
 */
router.put("/notifications", requireAuth, async (req, res) => {
  const allowed = [
    "notify_post",
    "notify_membership_expiring",
    "notify_purchase",
    "notify_request_completed",
    "notify_new_request",
    "notify_product_sale",
  ];
  const updates = [];
  const params = [req.user.id];
  let idx = 2;

  for (const key of allowed) {
    if (key in req.body && typeof req.body[key] === "boolean") {
      updates.push(`${key} = $${idx++}`);
      params.push(req.body[key]);
    }
  }

  if (!updates.length) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  const sql = `UPDATE users SET ${updates.join(", ")} WHERE id=$1 RETURNING
    notify_post,
    notify_membership_expiring,
    notify_purchase,
    notify_request_completed,
    notify_new_request,
    notify_product_sale`;

  const { rows } = await db.query(sql, params);
  res.json(rows[0]);
});

module.exports = router;