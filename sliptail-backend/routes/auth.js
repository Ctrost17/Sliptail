/* routes/auth.js */
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("../db");
const { sendEmail } = require("../emails/mailer");
const T = require("../emails/templates");
const { validate } = require("../middleware/validate");
const { authSignup, authLogin } = require("../validators/schemas");
const { strictLimiter } = require("../middleware/rateLimit");
const { notify } = require("../services/notifications"); // ⬅️ add notifications

const router = express.Router();

const {
  JWT_SECRET,
  APP_URL = "http://localhost:5000",
  FRONTEND_URL = "http://localhost:3000",
} = process.env;

const BASE_URL = APP_URL.replace(/\/$/, "");
const FRONTEND_BASE = FRONTEND_URL.replace(/\/$/, "");

/* ------------------------------- helpers ------------------------------- */

function toSafeUser(u) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    role: u.role,
    email_verified_at: u.email_verified_at,
    created_at: u.created_at,
  };
}

function issueJwt(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role || "user",
      email_verified_at: user.email_verified_at,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

/** Check if a given column exists (schema-aware updates) */
async function hasColumn(table, column) {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

/** For legacy compat: figure out which pending timestamp column is present */
async function getPendingSetAtColumn() {
  if (await hasColumn("users", "pending_email_set_at")) return "pending_email_set_at";
  if (await hasColumn("users", "pending_set_at")) return "pending_set_at"; // legacy name
  return null;
}

async function sendVerifyEmail(userId, email) {
  await db.query(
    `UPDATE user_tokens
        SET consumed_at = NOW()
      WHERE user_id = $1 AND token_type = 'email_verify' AND consumed_at IS NULL`,
    [userId]
  );

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await db.query(
    `INSERT INTO user_tokens (user_id, token, token_type, expires_at, created_at)
     VALUES ($1, $2, 'email_verify', $3, NOW())`,
    [userId, token, expires]
  );

  const verifyUrl = `${BASE_URL}/api/auth/verify?token=${token}`;

  // --- REPLACE the queue call with SES send ---
  const msg = T.emailVerification({
    actionUrl: verifyUrl,
    // 24 hours = 1440 minutes; adjust if you change token expiry above
    expiresInMinutes: 1440,
  });
  await sendEmail({
    to: email,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  });
}

async function sendVerifyNewEmail(userId, pendingEmail) {
  // Invalidate any previous verify tokens for this user
  await db.query(
    `UPDATE user_tokens
        SET consumed_at = NOW()
      WHERE user_id = $1 AND token_type = 'email_verify' AND consumed_at IS NULL`,
    [userId]
  );

  // Create a fresh verify token (24h)
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO user_tokens (user_id, token, token_type, expires_at, created_at)
     VALUES ($1, $2, 'email_verify', $3, NOW())`,
    [userId, token, expires]
  );

  // This hits your existing /api/auth/verify, which already
  // swaps pending_email -> email when present.
  const verifyUrl = `${BASE_URL}/api/auth/verify?token=${token}`;

  // ⬅️ Use the distinct template/subject
  const msg = T.newEmailVerification({ actionUrl: verifyUrl });
  await sendEmail({
    to: pendingEmail,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  });
}

// Use shared middleware for consistency
const { requireAuth } = require("../middleware/auth");

/* -------------------------------- routes -------------------------------- */

/**
 * POST /api/auth/signup
 * Body: { email, password, username? }
 */
router.post("/signup", strictLimiter, validate(authSignup), async (req, res) => {
  try {
    const { email, password, username } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    const lower = String(email).toLowerCase();

    const { rows: exists } = await db.query(
      `SELECT id FROM users WHERE email=$1 LIMIT 1`,
      [lower]
    );
    if (exists.length) {
      return res.status(409).json({ error: "Email already in use" });
    }

    const hash = await bcrypt.hash(password, 10);

    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, username, role, created_at)
       VALUES ($1, $2, $3, 'user', NOW())
       RETURNING *`,
      [lower, hash, username || null]
    );

    const user = rows[0];

    // ⬇️ Fire welcome notification (non-blocking)
    try {
      await notify(
        user.id,
        "welcome",
        "Welcome aboard!",
        "Your account has been successfully created. We’re glad to have you with us — start creating and supporting",
        {}
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("welcome notify failed:", e?.message || e);
    }

    try {
      await sendVerifyEmail(user.id, user.email);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("verify email enqueue failed:", e?.message || e);
    }

    return res.status(202).json({ checkEmail: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("signup error:", e);
    return res.status(500).json({ error: "Failed to sign up" });
  }
});

/**
 * POST /api/auth/verify/resend
 * Body: { email }
 * Always returns success to avoid user enumeration.
 */
router.post("/verify/resend", strictLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email is required" });
    const lower = String(email).toLowerCase();

    const { rows } = await db.query(
      `SELECT id, email_verified_at FROM users WHERE email=$1 LIMIT 1`,
      [lower]
    );
    if (rows.length && !rows[0].email_verified_at) {
      try {
        await sendVerifyEmail(rows[0].id, lower);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("resend verify enqueue failed:", e?.message || e);
      }
    }
    return res.json({ success: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("resend verify error:", e);
    return res.json({ success: true });
  }
});

/**
 * GET /api/auth/verify?token=...
 * If user has a pending email, swap it in and verify.
 * Otherwise, mark current email as verified (signup flow).
 */
router.get("/verify", async (req, res) => {
  const { token } = req.query || {};
  if (!token) return res.status(400).json({ error: "Missing token" });

  try {
    const { rows } = await db.query(
      `SELECT user_id
         FROM user_tokens
        WHERE token=$1
          AND token_type='email_verify'
          AND consumed_at IS NULL
          AND expires_at > NOW()
        LIMIT 1`,
      [token]
    );
    if (!rows.length) return res.status(400).json({ error: "Invalid or expired token" });

    const userId = rows[0].user_id;

    await db.query("BEGIN");

    const pendingCol = await getPendingSetAtColumn();
    const sets = [
      "email = COALESCE(pending_email, email)",
      "pending_email = NULL",
      "email_verified_at = NOW()",
      "updated_at = NOW()",
    ];
    if (pendingCol) sets.push(`${pendingCol} = NULL`);
    if (await hasColumn("users", "email_verified")) {
      sets.push("email_verified = TRUE");
    }

    await db.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1`, [userId]);
    await db.query(
      `UPDATE user_tokens
         SET consumed_at = NOW()
       WHERE token = $1`,
      [token]
    );

    await db.query("COMMIT");

    return res.redirect(`${FRONTEND_BASE}/auth/verified`);
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch {}
    // eslint-disable-next-line no-console
    console.error("verify error:", e);
    return res.status(500).json({ error: "Verification failed" });
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Requires verified email.
 * Also sets httpOnly cookie "token" so SSR/admin can authenticate.
 */
router.post("/login", strictLimiter, validate(authLogin), async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    const lower = String(email).toLowerCase();

    const { rows } = await db.query(
      `SELECT * FROM users WHERE email=$1 LIMIT 1`,
      [lower]
    );
    const user = rows[0];

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    if (!user.email_verified_at) {
      return res.status(403).json({ error: "Please verify your email to continue." });
    }

    const token = issueJwt(user);

    // Set HttpOnly cookie so SSR/fetch with credentials works; match logout clearing options
    try {
      res.cookie("token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV !== "development",
        path: "/",
        maxAge: 1 * 24 * 60 * 60 * 1000, // 1 day
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("Failed to set auth cookie:", e?.message || e);
    }

    return res.json({ token, user: toSafeUser(user) });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("login error:", e);
    return res.status(500).json({ error: "Failed to login" });
  }
});

/** POST /api/auth/logout — clears the httpOnly token cookie */
router.post("/logout", (_req, res) => {
  res.clearCookie("token", { path: "/" });
  res.json({ success: true });
});

/**
 * POST /api/auth/forgot
 * Body: { email }
 * Always responds success (prevents user enumeration)
 */
router.post("/forgot", strictLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email is required" });
    const lower = String(email).toLowerCase();

    const { rows } = await db.query(`SELECT id FROM users WHERE email=$1 LIMIT 1`, [lower]);
    if (rows.length) {
      const userId = rows[0].id;

      await db.query(
        `UPDATE user_tokens
            SET consumed_at = NOW()
          WHERE user_id=$1 AND token_type='password_reset' AND consumed_at IS NULL`,
        [userId]
      );

      const token = crypto.randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1h

      await db.query(
        `INSERT INTO user_tokens (user_id, token, token_type, expires_at, created_at)
         VALUES ($1, $2, 'password_reset', $3, NOW())`,
        [userId, token, expires]
      );

      try {
        const resetUrl = `${FRONTEND_BASE}/reset-password?token=${token}`;
        const msg = T.passwordReset({ actionUrl: resetUrl });
        await sendEmail({
          to: lower,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        });
      } catch (e) {
        console.warn("password reset email send failed:", e?.message || e);
      }
      }
    return res.json({ success: true, message: "If this email exists, a reset link was sent." });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("forgot error:", e);
    return res.status(500).json({ error: "Failed to process request" });
  }
});

/**
 * POST /api/auth/reset
 * Body: { token, password }
 */
router.post("/reset", strictLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ error: "token and password are required" });
    }

    const { rows } = await db.query(
      `SELECT user_id, expires_at, consumed_at
         FROM user_tokens
        WHERE token=$1 AND token_type='password_reset'`,
      [token]
    );
    const t = rows[0];
    if (!t) return res.status(400).json({ error: "Invalid token" });
    if (t.consumed_at) return res.status(400).json({ error: "Token already used" });
    if (new Date(t.expires_at) < new Date()) return res.status(400).json({ error: "Token expired" });

    const hashed = await bcrypt.hash(password, 10);

    await db.query("BEGIN");
    await db.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hashed, t.user_id]);
    await db.query(`UPDATE user_tokens SET consumed_at=NOW() WHERE token=$1`, [token]);
    await db.query("COMMIT");

    return res.json({ success: true, message: "Password updated" });
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch {}
    // eslint-disable-next-line no-console
    console.error("reset error:", e);
    return res.status(500).json({ error: "Failed to reset password" });
  }
});

/**
 * PATCH /api/auth/change-email
 * Body: { new_email, password }
 * Requires auth (Bearer or cookie)
 * Writes pending_email, then *attempts* to enqueue verify email OUTSIDE any transaction.
 */
router.patch("/change-email", strictLimiter, requireAuth, async (req, res) => {
  try {
    const { new_email, password } = req.body || {};
    if (!new_email || !password) {
      return res.status(400).json({ error: "new_email and password are required" });
    }
    const lower = String(new_email).toLowerCase();

    // Block if someone else already owns that email
    const { rows: dupe } = await db.query(
      `SELECT id FROM users WHERE email=$1 LIMIT 1`,
      [lower]
    );
    if (dupe.length && dupe[0].id !== req.user.id) {
      return res.status(409).json({ error: "Email already in use" });
    }

    // Check current password
    const { rows } = await db.query(
      `SELECT id, email, password_hash FROM users WHERE id=$1 LIMIT 1`,
      [req.user.id]
    );
    const me = rows[0];
    if (!me || !me.password_hash) return res.status(401).json({ error: "Unauthorized" });

    const ok = await bcrypt.compare(String(password), me.password_hash || "");
    if (!ok) return res.status(400).json({ error: "Invalid password" });

    // SET pending_email + timestamp
    const pendingCol = await getPendingSetAtColumn();
    const sets = ["pending_email = $1", "updated_at = NOW()"];
    if (pendingCol) sets.push(`${pendingCol} = NOW()`);
    await db.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $2`,
      [lower, req.user.id]
    );

    // Try to send verify email to the pending address; swallow any email-queue errors
    try {
    await sendVerifyNewEmail(req.user.id, lower);
    } catch (e) {
    console.warn("change-email: send new-email verify failed:", e?.message || e);
  }

    return res.json({
      success: true,
      requires_email_verify: true,
      message: "Email updated. Please verify your new email to continue.",
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("change-email error:", e);
    return res.status(500).json({ error: "Failed to change email" });
  }
});

/**
 * PATCH /api/auth/change-password
 * Body: { current_password, new_password }
 * Requires auth (Bearer or cookie)
 */
router.patch("/change-password", strictLimiter, requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: "current_password and new_password are required" });
    }
    if (String(new_password).length < 8) {
      return res.status(400).json({ error: "new_password must be at least 8 characters" });
    }

    const { rows } = await db.query(
      `SELECT id, password_hash FROM users WHERE id=$1 LIMIT 1`,
      [req.user.id]
    );
    const me = rows[0];
    if (!me || !me.password_hash) return res.status(401).json({ error: "Unauthorized" });

    const ok = await bcrypt.compare(String(current_password), me.password_hash || "");
    if (!ok) return res.status(400).json({ error: "Current password is incorrect" });

    const hashed = await bcrypt.hash(String(new_password), 10);
    await db.query(`UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2`, [hashed, req.user.id]);

    return res.json({ success: true, message: "Password updated. Please sign in again." });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("change-password error:", e);
    return res.status(500).json({ error: "Failed to change password" });
  }
});

/* ---------------------------------- me ---------------------------------- */

/**
 * GET /api/auth/me
 * Requires auth (Bearer or cookie)
 */
router.get("/me", requireAuth, async (req, res) => {
  const { id } = req.user || {};
  if (!id) return res.status(401).json({ error: "Unauthorized" });

  const { rows } = await db.query(
    `SELECT id, email, username, role, email_verified_at, created_at
       FROM users WHERE id=$1 LIMIT 1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  return res.json({ user: rows[0] });
});

module.exports = router;
