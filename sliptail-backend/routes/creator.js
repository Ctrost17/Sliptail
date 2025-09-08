const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

// Simple, fast status: creator if they have ANY product (or any active product)
router.get("/status", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await db.query(
      `SELECT
         EXISTS(SELECT 1 FROM products WHERE user_id=$1)       AS has_any,
         EXISTS(SELECT 1 FROM products WHERE user_id=$1 AND active=TRUE) AS has_active`,
      [userId]
    );
    const hasAny = rows[0]?.has_any === true || rows[0]?.has_any === "t";
    const hasActive = rows[0]?.has_active === true || rows[0]?.has_active === "t";
    // "active" means they’re a creator for nav purposes
    res.json({ active: hasAny || hasActive });
  } catch (e) {
    console.error("creator status error:", e);
    // Don’t break the UI — default to false
    res.status(200).json({ active: false });
  }
});

module.exports = router;