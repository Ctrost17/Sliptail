const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("../db");
const { enqueueAndSend } = require("../utils/emailQueue");
const { validate } = require("../middleware/validate");
const { authSignup, authLogin } = require("../validators/schemas");
const { strictLimiter } = require("../middleware/rateLimit");

const router = express.Router();

const {
  JWT_SECRET,
  APP_URL = "http://localhost:5000",
  FRONTEND_URL = "http://localhost:3000",
} = process.env;

const BASE_URL = APP_URL.replace(/\/$/, "");
const FRONTEND_BASE = FRONTEND_URL.replace(/\/$/, "");

// ---------- helpers ----------
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

async function sendVerifyEmail(userId, email) {
  // Invalidate any prior unconsumed verify tokens
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

  // Backend endpoint that will consume the token:
  const verifyUrl = `${BASE_URL}/api/auth/verify?token=${token}`;

  // IMPORTANT: your email_queue schema uses template + payload_json
  await enqueueAndSend({
    to: email,
    subject: "Verify your email",
    template: "verify_email",
    payload: { verify_url: verifyUrl },
  });
}

// ---------- routes ----------

/**
 * POST /api/auth/signup
 * Body: { email, password, username? }
 * Creates the user, sends verify email, DOES NOT issue JWT yet.
 */
router.post("/signup", strictLimiter, validate(authSignup), async (req, res) => {
  try {
    const { email, password, username } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }
    const lower = String(email).toLowerCase();

    // must not exist
    const { rows: exists } = await db.query(
      `SELECT id FROM users WHERE email=$1 LIMIT 1`,
      [lower]
    );
    if (exists.length) {
      return res.status(409).json({ error: "Email already in use" });
    }

    const hash = await bcrypt.hash(password, 10);

    // IMPORTANT: write to password_hash (not "password")
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, username, role, created_at)
       VALUES ($1, $2, $3, 'user', NOW())
       RETURNING *`,
      [lower, hash, username || null]
    );

    const user = rows[0];

    // Try to send verification email, but DO NOT fail signup if email queue/mailer crashes
    try {
      await sendVerifyEmail(user.id, user.email);
    } catch (e) {
      console.warn("verify email enqueue failed:", e?.message || e);
    }

    return res.status(202).json({ checkEmail: true });
  } catch (e) {
    console.error("signup error:", e);
    return res.status(500).json({ error: "Failed to sign up" });
  }
});

/**
 * POST /api/auth/verify/resend
 * Body: { email }
 * Resends a verify email if the account exists and is not verified.
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
        console.warn("resend verify enqueue failed:", e?.message || e);
      }
    }
    return res.json({ success: true });
  } catch (e) {
    console.error("resend verify error:", e);
    // still return success to avoid enumeration
    return res.json({ success: true });
  }
});

/**
 * GET /api/auth/verify?token=...
 * Consumes email verification token and marks user verified.
 * Redirects to FRONTEND_URL/​auth/verified for nice UX.
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
    // Mark user verified; keep both boolean and timestamp in sync if you use both
    await db.query(
      `UPDATE users
          SET email_verified = TRUE,
              email_verified_at = NOW()
        WHERE id = $1`,
      [userId]
    );
    await db.query(
      `UPDATE user_tokens
          SET consumed_at = NOW()
        WHERE token = $1`,
      [token]
    );
    await db.query("COMMIT");

    // Redirect to frontend "verified" page
    return res.redirect(`${FRONTEND_BASE}/auth/verified`);
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("verify error:", e);
    return res.status(500).json({ error: "Verification failed" });
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Requires email to be verified first.
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

    // Social-only or missing hash:
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.password_hash || "");
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    // block unverified users
    if (!user.email_verified_at) {
      return res.status(403).json({ error: "Please verify your email to continue." });
    }

    const token = issueJwt(user);
    return res.json({ token, user: toSafeUser(user) });
  } catch (e) {
    console.error("login error:", e);
    return res.status(500).json({ error: "Failed to login" });
  }
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

      // invalidate old tokens
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

      // Queue reset email using template + payload (matches email_queue schema)
      try {
        await enqueueAndSend({
          to: lower,
          subject: "Reset your password",
          template: "reset_password",
          payload: { reset_url: `${FRONTEND_BASE}/reset-password?token=${token}` },
        });
      } catch (e) {
        console.warn("password reset email enqueue failed:", e?.message || e);
      }
    }

    return res.json({ success: true, message: "If this email exists, a reset link was sent." });
  } catch (e) {
    console.error("forgot error:", e);
    return res.status(500).json({ error: "Failed to process request" });
  }
});

/**
 * POST /api/auth/reset
 * Body: { token, password }
 * Consumes token and sets new password
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
    // IMPORTANT: update password_hash
    await db.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hashed, t.user_id]);
    await db.query(`UPDATE user_tokens SET consumed_at=NOW() WHERE token=$1`, [token]);
    await db.query("COMMIT");

    return res.json({ success: true, message: "Password updated" });
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("reset error:", e);
    return res.status(500).json({ error: "Failed to reset password" });
  }
});

// --- lightweight bearer auth just for /me ---
function authFromBearer(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
    const token = h.slice("Bearer ".length);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (_) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

/**
 * GET /api/auth/me
 * Requires Authorization: Bearer <token>
 * Returns the safe user object so the client can populate auth state.
 */
router.get("/me", authFromBearer, async (req, res) => {
  const { id } = req.user || {};
  if (!id) return res.status(401).json({ error: "Unauthorized" });

  const { rows } = await db.query(
    `SELECT id, email, username, role, email_verified_at, created_at
       FROM users WHERE id=$1 LIMIT 1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  res.json({ user: rows[0] });
});

module.exports = router;