const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

/**
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