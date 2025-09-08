const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { enqueueAndSend } = require("../utils/emailQueue");
const { validate } = require("../middleware/validate");
const { sendVerifyEmail } = require("../validators/schemas");
const { strictLimiter } = require("../middleware/rateLimit");

const router = express.Router();

// Safe fallbacks so links don’t end up with "undefined"
const { APP_URL, FRONTEND_URL } = process.env;
const BASE_URL = (APP_URL || "http://localhost:5000").replace(/\/$/, "");
const FRONTEND_BASE = (FRONTEND_URL || "").replace(/\/$/, "");

/**
 * POST /api/email/verify/send
 * - logged-in user requests a fresh verification link
 */
router.post("/verify/send", requireAuth, strictLimiter, validate(sendVerifyEmail), async (req, res) => {
  const userId = req.user.id;

  try {
    // If already verified, short-circuit
    const { rows: u } = await db.query(
      `SELECT email, email_verified_at FROM users WHERE id=$1`,
      [userId]
    );
    const user = u[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user.email_verified_at) return res.json({ alreadyVerified: true });

    // Invalidate previous unconsumed verify tokens (optional but nice)
    await db.query(
      `UPDATE user_tokens
          SET consumed_at = NOW()
        WHERE user_id = $1 AND token_type='email_verify' AND consumed_at IS NULL`,
      [userId]
    );

    // Create token (24h)
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24);

    await db.query(
      `INSERT INTO user_tokens (user_id, token, token_type, expires_at)
       VALUES ($1,$2,'email_verify',$3)`,
      [userId, token, expires]
    );

    const verifyUrl = `${BASE_URL}/api/email/verify/${token}`;
    const html = `
      <h2>Verify your email</h2>
      <p>Click the link below to verify your email address:</p>
      <p><a href="${verifyUrl}">${verifyUrl}</a></p>
      <p>This link expires in 24 hours.</p>
    `;

    await enqueueAndSend({
      to: user.email,
      subject: "Verify your email",
      html,
      category: "email_verify",
    });

    res.json({ success: true });
  } catch (e) {
    console.error("send verify error:", e);
    res.status(500).json({ error: "Failed to send verification email" });
  }
});

/**
 * GET /api/email/verify/:token
 * - consumes token and marks user verified
 * - on success: optional redirect to FRONTEND_URL/verified?success=1
 */
router.get("/verify/:token", async (req, res) => {
  const token = req.params.token;

  try {
    const { rows } = await db.query(
      `SELECT user_id, expires_at, consumed_at
         FROM user_tokens
        WHERE token=$1 AND token_type='email_verify'`,
      [token]
    );
    const t = rows[0];
    if (!t) return res.status(400).json({ error: "Invalid token" });
    if (t.consumed_at) return res.status(400).json({ error: "Token already used" });
    if (new Date(t.expires_at) < new Date()) return res.status(400).json({ error: "Token expired" });

    await db.query("BEGIN");
    await db.query(`UPDATE users SET email_verified_at=NOW() WHERE id=$1`, [t.user_id]);
    await db.query(`UPDATE user_tokens SET consumed_at=NOW() WHERE token=$1`, [token]);
    await db.query("COMMIT");

    if (FRONTEND_BASE) {
      return res.redirect(`${FRONTEND_BASE}/verified?success=1`);
    }
    return res.json({ success: true, message: "Email verified" });
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("verify error:", e);
    res.status(500).json({ error: "Verification failed" });
  }
});

module.exports = router;