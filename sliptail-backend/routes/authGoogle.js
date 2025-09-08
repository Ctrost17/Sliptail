const express = require("express");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const db = require("../db");
const jwt = require("jsonwebtoken");

const router = express.Router();

const {
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL, FRONTEND_URL, JWT_SECRET
} = process.env;

passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const googleId = profile.id;
    const email = profile.emails && profile.emails[0]?.value;
    const emailVerified = profile.emails && profile.emails[0]?.verified;

    if (!email) return done(null, false);

    // find or create user
    const { rows } = await db.query(`SELECT * FROM users WHERE google_id=$1 OR email=$2 LIMIT 1`, [googleId, email]);
    let user = rows[0];

    if (!user) {
      // create user with verified email (Google gives verified flag)
      const { rows: ins } = await db.query(
        `INSERT INTO users (email, google_id, username, email_verified_at, created_at)
         VALUES ($1,$2,$3,$4,NOW()) RETURNING *`,
        [email, googleId, profile.displayName || email.split("@")[0], emailVerified ? new Date() : null]
      );
      user = ins[0];
    } else if (!user.google_id) {
      // link google to existing account
      await db.query(`UPDATE users SET google_id=$1 WHERE id=$2`, [googleId, user.id]);
      if (emailVerified && !user.email_verified_at) {
        await db.query(`UPDATE users SET email_verified_at=NOW() WHERE id=$1`, [user.id]);
      }
    }

    return done(null, user);
  } catch (e) {
    return done(e);
  }
}));

router.get("/google/start", passport.authenticate("google", {
  scope: ["profile", "email"]
}));

router.get("/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: (FRONTEND_URL || "/") }),
  async (req, res) => {
    const user = req.user;
    // issue your normal JWT
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });

    // redirect back to frontend with token in fragment or query
    const base = (FRONTEND_URL || "http://localhost:3000").replace(/\/$/,"");
    return res.redirect(`${base}/oauth-complete#token=${token}`);
  }
);

module.exports = router;