// routes/me.js
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

// Read from Stripe only as a fallback (DB first for speed/reliability)
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

const router = express.Router();

/* ----------------------------- helpers ----------------------------- */
function toSafeUser(u) {
  return {
    id: u.id,
    email: u.email,
    username: u.username || null,
    role: u.role, // rely on users.role exactly as you want
    email_verified_at: u.email_verified_at || null,
    created_at: u.created_at,
  };
}

/* ----------------------- GET /api/me (NEW) ------------------------ */
/**
 * Returns the authenticated user record (including `role`).
 * Frontend uses this to decide if the user is a creator.
 */
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, username, role, email_verified_at, created_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "User not found" });
    return res.json({ ok: true, user: toSafeUser(rows[0]) });
  } catch (e) {
    next(e);
  }
});

/* --------------- GET /api/me/creator-status (existing) --------------- */
/**
 * Returns creator readiness flags (optional in your flow).
 * You’re still free to rely only on users.role on the frontend.
 */
async function getStripeConnectionState(dbConn, userId) {
  const uid = String(userId);

  // 1) Try DB snapshot first
  try {
    const r = await dbConn.query(
      `
      SELECT details_submitted, charges_enabled, payouts_enabled
      FROM stripe_connect
      WHERE user_id::text = $1
      LIMIT 1
      `,
      [uid]
    );
    if (r.rows[0]) {
      const {
        details_submitted = false,
        charges_enabled = false,
        payouts_enabled = false,
      } = r.rows[0];
      return {
        details_submitted: !!details_submitted,
        charges_enabled: !!charges_enabled,
        payouts_enabled: !!payouts_enabled,
        present: true,
      };
    }
  } catch (_) {
    // ignore; fallback to Stripe
  }

  // 2) Fallback to live Stripe
  try {
    const { rows: [u] = [] } = await dbConn.query(
      `SELECT stripe_account_id FROM users WHERE id::text = $1 LIMIT 1`,
      [uid]
    );
    const acctId = u?.stripe_account_id;
    if (!acctId) {
      return { details_submitted: false, charges_enabled: false, payouts_enabled: false, present: false };
    }
    const acct = await stripe.accounts.retrieve(acctId);
    return {
      details_submitted: !!acct?.details_submitted,
      charges_enabled: !!acct?.charges_enabled,
      payouts_enabled: !!acct?.payouts_enabled,
      present: true,
    };
  } catch (e) {
    console.warn("[creator-status] Stripe retrieve failed:", e.message || e);
    return { details_submitted: false, charges_enabled: false, payouts_enabled: false, present: false };
  }
}

router.get("/creator-status", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const uid = String(userId);

  try {
    // Profile flags (best-effort)
    let profileComplete = false;
    let isActive = false;
    try {
      const { rows: [cp] = [] } = await db.query(
        `
        SELECT
          COALESCE(is_profile_complete, FALSE) AS is_profile_complete,
          COALESCE(is_active, FALSE)           AS is_active
        FROM creator_profiles
        WHERE user_id::text = $1
        LIMIT 1
        `,
        [uid]
      );
      if (cp) {
        profileComplete = !!cp.is_profile_complete;
        isActive = !!cp.is_active;
      }
    } catch (_) {}

    // Any active product published?
    let hasPublishedProduct = false;
    try {
      const { rows: [row] = [] } = await db.query(
        `
        SELECT COUNT(*)::int AS cnt
        FROM products
        WHERE user_id::text = $1 AND active = TRUE
        `,
        [uid]
      );
      hasPublishedProduct = (row?.cnt || 0) > 0;
    } catch (_) {}

    // Stripe connection snapshot/fallback
    const s = await getStripeConnectionState(db, uid);
    const stripeConnected = !!(s.details_submitted && s.charges_enabled && s.payouts_enabled);

    return res.json({
      profileComplete,
      stripeConnected,
      hasPublishedProduct,
      isActive,
    });
  } catch (e) {
    console.error("creator-status error:", e);
    return res.status(500).json({ error: "Failed to load creator status", details: e.message });
  }
});

module.exports = router;
