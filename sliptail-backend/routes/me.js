const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

// Read from Stripe only as a fallback (DB first for speed/reliability)
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

const router = express.Router();

/**
 * Helper: fetch Stripe flags from DB (stripe_connect), falling back to Stripe API if needed.
 */
async function getStripeConnectionState(db, userId) {
  const uid = String(userId);

  // 1) Try DB first (authoritative snapshot written by /api/stripe-connect/sync & webhook)
  try {
    const r = await db.query(
      `
      SELECT details_submitted, charges_enabled, payouts_enabled
      FROM stripe_connect
      WHERE user_id::text = $1
      LIMIT 1
      `,
      [uid]
    );
    if (r.rows[0]) {
      const { details_submitted = false, charges_enabled = false, payouts_enabled = false } = r.rows[0];
      return {
        details_submitted: !!details_submitted,
        charges_enabled: !!charges_enabled,
        payouts_enabled: !!payouts_enabled,
        present: true,
      };
    }
  } catch (e) {
    // table may not exist yet in some envs; ignore and fall back
    // console.warn("[creator-status] stripe_connect read warn:", e.message || e);
  }

  // 2) Fallback: try live Stripe (only if we have an account id)
  try {
    const { rows: [u] = [] } = await db.query(
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
    // Stripe failure shouldn't break the endpoint
    console.warn("[creator-status] Stripe retrieve failed:", e.message || e);
    return { details_submitted: false, charges_enabled: false, payouts_enabled: false, present: false };
  }
}

/**
 * GET /api/me/creator-status
 * Returns:
 *  {
 *    profileComplete: boolean,
 *    stripeConnected: boolean,
 *    hasPublishedProduct: boolean,
 *    isActive: boolean
 *  }
 */
router.get("/creator-status", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const uid = String(userId);

  try {
    // Profile status (be tolerant about schema)
    let profileComplete = false;
    let isActive = false;
    try {
      const { rows: [cp] = [] } = await db.query(
        `
        SELECT
          -- prefer explicit flags if you have them
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
    } catch (e) {
      // creator_profiles might not exist yet; leave defaults
      // console.warn("[creator-status] creator_profiles read warn:", e.message || e);
    }

    // Products: count published/active
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
    } catch (e) {
      // products table might not be present in some envs
      // console.warn("[creator-status] products read warn:", e.message || e);
    }

    // Stripe connection (DB first, Stripe fallback)
    const s = await getStripeConnectionState(db, uid);
    const stripeConnected = !!(s.details_submitted && s.charges_enabled && s.payouts_enabled);

    // Respond with your existing shape
    return res.json({
      profileComplete,
      stripeConnected,
      hasPublishedProduct,
      isActive, // if you prefer a computed status: (profileComplete && stripeConnected && hasPublishedProduct)
    });
  } catch (e) {
    console.error("creator-status error:", e);
    return res.status(500).json({ error: "Failed to compute creator status" });
  }
});

module.exports = router;
