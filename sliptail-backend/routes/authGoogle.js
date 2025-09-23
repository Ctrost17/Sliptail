// backend/routes/authGoogle.js
const express = require("express");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const db = require("../db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const router = express.Router();

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_CALLBACK_URL,
  FRONTEND_URL = "http://localhost:3000",
  JWT_SECRET,
} = process.env;

/* ---------------------- sanity checks for fast debugging ---------------------- */
function assertEnvOrThrow() {
  const missing = [];
  if (!GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
  if (!GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!GOOGLE_CALLBACK_URL) missing.push("GOOGLE_CALLBACK_URL");
  if (!JWT_SECRET) missing.push("JWT_SECRET");
  if (missing.length) {
    const msg = `[Google OAuth] Missing env: ${missing.join(", ")}`;
    console.error(msg);
    throw new Error(msg);
  }
}
assertEnvOrThrow();

/* ------------------------------ helpers -------------------------------------- */
function baseUsernameFromProfile(profile, email) {
  const fromName = (profile.displayName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
  const fallback = (email || "").split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const base = (fromName || fallback || "user").slice(0, 30);
  return base || "user";
}

async function makeUniqueUsername(base) {
  let candidate = base;
  let i = 0;
  // Try base, base_1, base_2, ... up to a reasonable bound
  while (true) {
    const { rows } = await db.query(`SELECT 1 FROM users WHERE username = $1 LIMIT 1`, [candidate]);
    if (!rows.length) return candidate;
    i += 1;
    candidate = `${base}_${i}`;
    if (candidate.length > 40) candidate = `${base.slice(0, 30)}_${i}`; // keep it sane
    if (i > 200) return `${base}_${crypto.randomBytes(3).toString("hex")}`; // emergency fallback
  }
}

async function randomPasswordHash() {
  const random = crypto.randomBytes(48).toString("hex");
  return bcrypt.hash(random, 10); // valid bcrypt string; user cannot guess this
}

/* --------------------------- Passport Google setup --------------------------- */
passport.use(
  new GoogleStrategy(
    {
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: GOOGLE_CALLBACK_URL, // MUST EXACTLY MATCH Google console
      passReqToCallback: true,
    },
    // verify callback: create/find local user, then done(null, user)
    async (req, accessToken, refreshToken, profile, done) => {
      try {
        const googleEmail =
          (profile.emails && profile.emails[0] && profile.emails[0].value) || null;
        if (!googleEmail) {
          return done(new Error("No email returned by Google"), null);
        }
        const email = googleEmail.toLowerCase();

        // See if a user already exists for this email
        const existingRes = await db.query(
          `SELECT id, email, username, role, email_verified, email_verified_at, created_at
             FROM users
            WHERE email = $1
            LIMIT 1`,
          [email]
        );

        if (existingRes.rows.length) {
          // Ensure verified flags are set (since Google verified the email)
          const u = existingRes.rows[0];
          if (!u.email_verified || !u.email_verified_at) {
            const up = await db.query(
              `UPDATE users
                  SET email_verified = TRUE,
                      email_verified_at = COALESCE(email_verified_at, NOW()),
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, email, username, role, email_verified, email_verified_at, created_at`,
              [u.id]
            );
            return done(null, up.rows[0]);
          }
          return done(null, u);
        }

        // New Google user → create a row (password_hash is required by your schema)
        const username = await makeUniqueUsername(
          baseUsernameFromProfile(profile, email)
        );
        const password_hash = await randomPasswordHash();

        const insertRes = await db.query(
          `INSERT INTO users
             (email, password_hash, role, username, email_verified, email_verified_at)
           VALUES
             ($1,    $2,            'user', $3,       TRUE,          NOW())
           RETURNING id, email, username, role, email_verified, email_verified_at, created_at`,
          [email, password_hash, username]
        );

        const user = insertRes.rows[0];

        // Optional: link Google subject for future (uncomment if you have such a table)
        // await db.query(
        //   `INSERT INTO user_providers(user_id, provider, provider_id)
        //     VALUES($1, 'google', $2)
        //     ON CONFLICT (provider, provider_id) DO NOTHING`,
        //   [user.id, profile.id]
        // );

        return done(null, user);
      } catch (err) {
        console.error("[Google OAuth] verify error:", err);
        return done(err, null);
      }
    }
  )
);

/* --------------------------- OAuth entry (“start”) --------------------------- */
// We preserve ?next=... through OAuth using the `state` param.
router.get("/google/start", (req, res, next) => {
  try {
    const nextParam = typeof req.query.next === "string" ? req.query.next : undefined;

    passport.authenticate("google", {
      session: false,
      scope: ["profile", "email"],
      prompt: "select_account",
      state: nextParam, // round-trip desired landing page
    })(req, res, next);
  } catch (e) {
    console.error("[Google OAuth] /google/start error:", e);
    res.status(500).json({ error: "OAuth start failed", detail: String(e) });
  }
});

/* ------------------------------ OAuth callback ------------------------------ */
router.get(
  "/google/callback",
  (req, res, next) => {
    if (req.query.error) {
      console.error("[Google OAuth] callback error:", req.query.error, req.query.error_description);
    }
    next();
  },
  passport.authenticate("google", {
    session: false,
    failureRedirect: FRONTEND_URL + "/auth/login?oauth_error=1",
  }),
  async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        console.error("[Google OAuth] No user on req after authenticate()");
        return res.redirect(FRONTEND_URL + "/auth/login?oauth_error=1");
      }

      const token = jwt.sign(
        { id: user.id, email: user.email },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      // Forward ?next=... if we got one in state.
      const nextParam = typeof req.query.state === "string" ? req.query.state : "/";
      const base = FRONTEND_URL.replace(/\/$/, "");
      const url = `${base}/oauth-complete?next=${encodeURIComponent(nextParam)}#token=${encodeURIComponent(token)}`;

      return res.redirect(url);
    } catch (e) {
      console.error("[Google OAuth] callback handler error:", e);
      return res.redirect(FRONTEND_URL + "/auth/login?oauth_error=1");
    }
  }
);

/* -------------------------- quick health/debug route ------------------------- */
router.get("/google/health", (req, res) => {
  res.json({
    ok: true,
    hasClient: !!GOOGLE_CLIENT_ID,
    hasSecret: !!GOOGLE_CLIENT_SECRET,
    callback: GOOGLE_CALLBACK_URL,
    frontend: FRONTEND_URL,
  });
});

module.exports = router;
