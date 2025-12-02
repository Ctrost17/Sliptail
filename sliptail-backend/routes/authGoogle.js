// backend/routes/authGoogle.js
const express = require("express");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const db = require("../db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { notify } = require("../services/notifications");


const router = express.Router();

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_CALLBACK_URL,
  FRONTEND_URL = "http://localhost:3000",
  JWT_SECRET,
} = process.env;

// Determine configuration status instead of throwing on import
const missing = [];
if (!GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
if (!GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
if (!GOOGLE_CALLBACK_URL) missing.push("GOOGLE_CALLBACK_URL");
if (!JWT_SECRET) missing.push("JWT_SECRET");
const OAUTH_CONFIGURED = missing.length === 0;
if (!OAUTH_CONFIGURED) {
  console.warn(
    `[Google OAuth] Disabled — missing env: ${missing.join(", ")}. The server will continue without Google OAuth.`
  );
}

// Build a callback URL based on the incoming host, falling back to GOOGLE_CALLBACK_URL
function getCallbackURL(req) {
  // If we don't have a configured base callback, just return it as-is
  if (!GOOGLE_CALLBACK_URL) {
    return GOOGLE_CALLBACK_URL;
  }

  const hostHeader = (req.headers.host || "").split(":")[0];
  if (!hostHeader) {
    return GOOGLE_CALLBACK_URL;
  }

  try {
    // GOOGLE_CALLBACK_URL is your base, e.g. https://sliptail.com/api/auth/google/callback
    const base = new URL(GOOGLE_CALLBACK_URL);
    // Keep the path from the env, but swap in the current host and protocol
    base.host = hostHeader;
    // Try to use the real protocol, default to https in production
    base.protocol = req.protocol || base.protocol || "https:";
    return base.toString();
  } catch (e) {
    console.warn("[Google OAuth] getCallbackURL failed, falling back:", e?.message || e);
    return GOOGLE_CALLBACK_URL;
  }
}

// Build the frontend base URL from the incoming host (for redirects after login)
function getFrontendBase(req) {
  const hostHeader = (req.headers.host || "").split(":")[0];
  if (!hostHeader) {
    // fallback to the env-based frontend URL (sliptail.com)
    return FRONTEND_URL.replace(/\/$/, "");
  }
  const protocol = req.protocol || "https";
  return `${protocol}://${hostHeader}`;
}

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
if (OAUTH_CONFIGURED) {
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

            // mark as freshly created (in-memory only; not stored in DB)
            user.__just_created = true;

            return done(null, user);
        } catch (err) {
          console.error("[Google OAuth] verify error:", err);
          return done(err, null);
        }
      }
    )
  );
}

/* --------------------------- OAuth entry (“start”) --------------------------- */
// We preserve ?next=... through OAuth using the `state` param.
if (OAUTH_CONFIGURED) {
      router.get("/google/start", (req, res, next) => {
        try {
          const nextParam = typeof req.query.next === "string" ? req.query.next : undefined;
          const callbackURL = getCallbackURL(req);

          passport.authenticate("google", {
            session: false,
            scope: ["profile", "email"],
            prompt: "select_account",
            state: nextParam, // round-trip desired landing page
            callbackURL,      // domain-aware callback
          })(req, res, next);
        } catch (e) {
          console.error("[Google OAuth] /google/start error:", e);
          res.status(500).json({ error: "OAuth start failed", detail: String(e) });
        }
      });
} else {
  router.get("/google/start", (_req, res) => {
    res.status(503).json({ error: "Google OAuth is not configured", missing });
  });
}

/* ------------------------------ OAuth callback ------------------------------ */
if (OAUTH_CONFIGURED) {
 router.get(
  "/google/callback",
  (req, res, next) => {
    if (req.query.error) {
      console.error(
        "[Google OAuth] callback error:",
        req.query.error,
        req.query.error_description
      );
    }
    next();
  },
  (req, res, next) => {
    // Use a domain-aware callback URL here as well
    const callbackURL = getCallbackURL(req);

    passport.authenticate("google", {
      session: false,
      failureRedirect: getFrontendBase(req) + "/auth/login?oauth_error=1",
      callbackURL,
    })(req, res, next);
  },
  async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        console.error("[Google OAuth] No user on req after authenticate()");
        return res.redirect(getFrontendBase(req) + "/auth/login?oauth_error=1");
      }

      // fresh JWT
      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role || "user",
          email_verified_at: user.email_verified_at ?? null,
        },
        JWT_SECRET,
        { expiresIn: "7d" }
      );

      // Set session cookie on the current domain (agency or Sliptail)
      res.cookie("token", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV !== "development",
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      // Welcome notification only if just created
      if (user.__just_created) {
        try {
          await notify(
            user.id,
            "welcome",
            "Welcome aboard!",
            "Your account has been successfully created. We’re glad to have you with us — start creating and supporting",
            { source: "google_oauth" }
          );
        } catch (e) {
          console.warn("[Google OAuth] welcome notify (callback) failed:", e?.message || e);
        }
      }

      // Redirect back to the right domain
      const state = typeof req.query.state === "string" ? req.query.state : "/";
      const nextPath = state.startsWith("/") ? state : "/";
      const base = getFrontendBase(req); // e.g. https://sliptail.com or https://members.agency.com

      return res.redirect(`${base}/auth/complete?next=${encodeURIComponent(nextPath)}`);
    } catch (e) {
      console.error("[Google OAuth] callback handler error:", e);
      return res.redirect(getFrontendBase(req) + "/auth/login?oauth_error=1");
    }
  }
);
} else {
  router.get("/google/callback", (_req, res) => {
    return res.redirect(FRONTEND_URL + "/auth/login?oauth_error=1");
  });
}

/* -------------------------- quick health/debug route ------------------------- */
router.get("/google/health", (_req, res) => {
  res.json({
    ok: OAUTH_CONFIGURED,
    configured: OAUTH_CONFIGURED,
    missing,
    hasClient: !!GOOGLE_CLIENT_ID,
    hasSecret: !!GOOGLE_CLIENT_SECRET,
    callback: GOOGLE_CALLBACK_URL,
    frontend: FRONTEND_URL,
  });
});

module.exports = router;
