// routes/stripeConnect.js
const express = require("express");
const Stripe = require("stripe");
const db = require("../db");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { requireAuth } = require("../middleware/auth");
const { recomputeCreatorActive } = require("../services/creatorStatus");
const crypto = require("crypto");
const { URLSearchParams } = require("url");

const router = express.Router();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("Stripe not configured: missing STRIPE_SECRET_KEY");
  }
  return Stripe(key);
}

// Prefer FRONTEND_URL; fall back to APP_URL; default to local Next dev URL
const FRONTEND_BASE = (
  process.env.FRONTEND_URL ||
  process.env.APP_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

// Backend base for OAuth callback (your Express server)
const BACKEND_BASE = (
  process.env.BACKEND_URL ||
  process.env.API_URL ||
  "http://localhost:5000"
).replace(/\/$/, "");

// Stripe Connect Standard client id (from Stripe Dashboard)
const CONNECT_CLIENT_ID = process.env.STRIPE_CONNECT_CLIENT_ID || "";

// Optional: set this if you add the webhook below
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
/* ----------------------------- helpers ----------------------------- */

function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeState(state) {
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Best-effort create; if your table already exists with a different shape, we handle it dynamically below. */
async function ensureStripeConnectTable() {
  await db
    .query(`
      CREATE TABLE IF NOT EXISTS stripe_connect (
        user_id TEXT PRIMARY KEY,
        stripe_account_id TEXT,
        details_submitted BOOLEAN DEFAULT FALSE,
        charges_enabled   BOOLEAN DEFAULT FALSE,
        payouts_enabled   BOOLEAN DEFAULT FALSE,
        connected_at      TIMESTAMP NULL,
        updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `)
    .catch(() => {
      // If an older table exists (e.g., user_id INT, account_id TEXT), that's OK — we adapt at runtime.
    });
}

/** Inspect existing stripe_connect schema (supports legacy: account_id + integer user_id). */
async function detectStripeConnectSchema() {
  const { rows } = await db.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='stripe_connect'
  `);

  const hasStripeAccountId = rows.some(r => r.column_name === "stripe_account_id");
  const hasAccountId       = rows.some(r => r.column_name === "account_id");
  const accountCol         = hasStripeAccountId ? "stripe_account_id" : (hasAccountId ? "account_id" : null);

  const userCol = rows.find(r => r.column_name === "user_id");
  const userIsInteger = !!userCol && /integer/.test(userCol.data_type);

  const hasConnectedAt = rows.some(r => r.column_name === "connected_at");

  if (!accountCol) {
    throw new Error("stripe_connect table must have either 'stripe_account_id' or 'account_id' column");
  }

  return { accountCol, userIsInteger, hasConnectedAt };
}

/**
 * Persist Stripe Account flags to DB and mirror to other tables (schema-adaptive).
 * - Upserts into `stripe_connect` (works with account_id or stripe_account_id; user_id INT or TEXT)
 * - UPSERT-mirrors to `creator_profiles.stripe_charges_enabled` when that column exists
 * - We do NOT decide users.stripe_connected here; you already flip it when account_id is created.
 */
async function upsertStripeState(userId, acct) {
  const uid = String(userId);
  const accountId = acct?.id || null;
  const details_submitted = !!acct?.details_submitted;
  const charges_enabled   = !!acct?.charges_enabled;
  const payouts_enabled   = !!acct?.payouts_enabled;

  await ensureStripeConnectTable();

  // Detect actual schema and build a compatible upsert
  const { accountCol, userIsInteger, hasConnectedAt } = await detectStripeConnectSchema();

  // user_id casting
  const userParam = userIsInteger ? "CAST($1 AS integer)" : "$1";

  // columns + values
  const insertCols = [
    "user_id",
    accountCol,
    "details_submitted",
    "charges_enabled",
    "payouts_enabled",
    ...(hasConnectedAt ? ["connected_at"] : []),
    "updated_at",
  ];

  const insertValsSql = [
    userParam, "$2", "$3", "$4", "$5",
    ...(hasConnectedAt ? ["CASE WHEN $3 = TRUE THEN NOW() ELSE NULL END"] : []),
    "NOW()",
  ];

  // conflict updates
  const setPairs = [
    `${accountCol} = COALESCE(EXCLUDED.${accountCol}, stripe_connect.${accountCol})`,
    `details_submitted = EXCLUDED.details_submitted`,
    `charges_enabled   = EXCLUDED.charges_enabled`,
    `payouts_enabled   = EXCLUDED.payouts_enabled`,
    ...(hasConnectedAt
      ? [
          `connected_at = CASE
                             WHEN EXCLUDED.details_submitted = TRUE
                                  AND stripe_connect.connected_at IS NULL
                             THEN NOW()
                             ELSE stripe_connect.connected_at
                           END`,
        ]
      : []),
    `updated_at        = NOW()`,
  ];

  // perform upsert
  await db.query(
    `
    INSERT INTO stripe_connect (${insertCols.join(", ")})
    VALUES (${insertValsSql.join(", ")})
    ON CONFLICT (user_id) DO UPDATE
      SET ${setPairs.join(", ")}
    `,
    [uid, accountId, details_submitted, charges_enabled, payouts_enabled]
  );

  // Mirror to creator_profiles.stripe_charges_enabled if the column exists; UPSERT so new creators get a row.
  try {
    const { rows: hasCol } = await db.query(
      `
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='creator_profiles'
         AND column_name='stripe_charges_enabled'
       LIMIT 1
      `
    );
    if (hasCol.length) {
      await db.query(
        `
        INSERT INTO creator_profiles (user_id, stripe_charges_enabled, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id) DO UPDATE
          SET stripe_charges_enabled = EXCLUDED.stripe_charges_enabled,
              updated_at = NOW()
        `,
        [uid, charges_enabled]
      );
    }
  } catch (e) {
    if (!/stripe_charges_enabled/.test(String(e.message))) {
      console.warn("creator_profiles upsert warn:", e.message || e);
    }
  }

  return { account_id: accountId, details_submitted, charges_enabled, payouts_enabled };
}

/* ------------------------------ routes ------------------------------ */

/**
 * POST /api/stripe-connect/create-link
 * - For Standard accounts, returns an OAuth URL for the frontend to redirect the creator to
 */
router.post("/create-link", requireAuth, async (req, res) => {
  const userId = req.user.id;

  if (!CONNECT_CLIENT_ID) {
    return res
      .status(500)
      .json({ error: "Stripe Connect not configured: missing STRIPE_CONNECT_CLIENT_ID" });
  }

  try {
    // Load user and creator profile
    const { rows } = await db.query(
      `
      SELECT u.id,
             u.email,
             u.stripe_account_id,
             cp.display_name
        FROM users u
        LEFT JOIN creator_profiles cp ON cp.user_id = u.id
       WHERE u.id = $1
       LIMIT 1
      `,
      [userId]
    );

    const me = rows[0];
    if (!me) {
      return res.status(404).json({ error: "User not found" });
    }

    // If already connected to a Standard account, nothing to start
    if (me.stripe_account_id) {
      return res.json({
        already_connected: true,
        account_id: me.stripe_account_id,
        mode: "standard",
      });
    }

    const displayName = me.display_name || `Sliptail Creator #${me.id}`;

    // Encode state so callback knows which user to attach
    const state = encodeState({
      user_id: userId,
      ts: Date.now(),
      nonce: crypto.randomBytes(16).toString("hex"),
    });

    const redirectUri = `${BACKEND_BASE}/api/stripe-connect/oauth/callback`;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CONNECT_CLIENT_ID,
      scope: "read_write",
      redirect_uri: redirectUri,
      state,
    });

    if (me.email) {
      params.append("stripe_user[email]", me.email);
    }
    params.append("stripe_user[business_name]", displayName);
    params.append("stripe_user[website_url]", FRONTEND_BASE);

    const url = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;

    return res.json({
      url,
      account_id: null,
      mode: "oauth",
    });
  } catch (e) {
    console.error("Stripe Connect create-link (standard) error:", e);
    return res
      .status(500)
      .json({ error: "Failed to start Stripe Connect", details: e.message });
  }
});

// GET /api/stripe-connect/oauth/callback
// This is the redirect URL configured in Stripe Dashboard
router.get("/oauth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // User cancelled or error from Stripe
  if (error) {
    console.error("Stripe Connect OAuth error:", error, error_description);
    return res.redirect(
      302,
      `${FRONTEND_BASE}/creator/setup?stripe_error=1`
    );
  }

  if (!code || !state) {
    console.error("Stripe Connect OAuth callback missing code or state");
    return res.redirect(
      302,
      `${FRONTEND_BASE}/creator/setup?stripe_error=1`
    );
  }

  const decoded = decodeState(state);
  const userId = decoded && decoded.user_id;
  if (!userId) {
    console.error("Stripe Connect OAuth: invalid state");
    return res.redirect(
      302,
      `${FRONTEND_BASE}/creator/setup?stripe_error=1`
    );
  }

  try {
    const stripe = getStripe();

    // Exchange code for access tokens and connected account id
    const tokenResp = await stripe.oauth.token({
      grant_type: "authorization_code",
      code: String(code),
    });

    const accountId = tokenResp.stripe_user_id;
    if (!accountId) {
      throw new Error("No stripe_user_id in OAuth response");
    }

    // 1) Store account id on users
    await db.query(
      `
      UPDATE users
         SET stripe_account_id = $1,
             stripe_connected   = TRUE,
             updated_at         = NOW()
       WHERE id = $2
      `,
      [accountId, userId]
    );

    // 2) Seed / update stripe_connect table in a schema compatible way
    try {
      await ensureStripeConnectTable();
      const { accountCol, userIsInteger } = await detectStripeConnectSchema();
      const userParam = userIsInteger ? "CAST($1 AS integer)" : "$1";

      await db.query(
        `
        INSERT INTO stripe_connect (user_id, ${accountCol}, updated_at)
        VALUES (${userParam}, $2, NOW())
        ON CONFLICT (user_id) DO UPDATE
          SET ${accountCol} = EXCLUDED.${accountCol},
              updated_at    = NOW()
        `,
        [String(userId), accountId]
      );
    } catch (seedErr) {
      console.warn(
        "[oauth-callback] seed stripe_connect warn:",
        seedErr.message || seedErr
      );
    }

    // 3) Pull latest flags and recompute creator active
    try {
      const acct = await stripe.accounts.retrieve(accountId);
      await upsertStripeState(userId, acct);
      try {
        await recomputeCreatorActive(db, userId);
      } catch {}
    } catch (syncErr) {
      console.warn(
        "[oauth-callback] post connect sync warn:",
        syncErr.message || syncErr
      );
    }

    // Redirect back to creator setup
    return res.redirect(
      302,
      `${FRONTEND_BASE}/creator/setup?onboarded=1`
    );
  } catch (e) {
    console.error("Stripe Connect OAuth callback error:", e);
    return res.redirect(
      302,
      `${FRONTEND_BASE}/creator/setup?stripe_error=1`
    );
  }
});

/**
 * POST /api/stripe-connect/sync
 * Refreshes from Stripe and persists flags to DB.
 */
router.post("/sync", requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT stripe_account_id FROM users WHERE id=$1 LIMIT 1`,
      [userId]
    );
    const accountId = rows[0]?.stripe_account_id;
    if (!accountId) {
      return res.status(400).json({ error: "No connected account on file" });
    }

    const stripe = getStripe();
    const acct = await stripe.accounts.retrieve(accountId);

    const snapshot = await upsertStripeState(userId, acct);

    let creator_status = null;
    try {
      creator_status = await recomputeCreatorActive(db, userId);
    } catch (_statusErr) {}

    return res.json({
      synced: true,
      account_id: snapshot.account_id,
      details_submitted: snapshot.details_submitted,
      charges_enabled: snapshot.charges_enabled,
      payouts_enabled: snapshot.payouts_enabled,
      creator_status,
    });
  } catch (e) {
    console.error("Stripe Connect sync error:", e);
    return res.status(500).json({ error: "Failed to sync Stripe account" });
  }
});

/**
 * GET /api/stripe-connect/status
 */
router.get("/status", requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const { rows } = await db.query(
      `SELECT stripe_account_id FROM users WHERE id=$1`,
      [userId]
    );
    const accountId = rows[0]?.stripe_account_id;
    if (!accountId) {
      return res.json({ has_account: false });
    }

    const stripe = getStripe(); // ← you forgot this line here
    const acct = await stripe.accounts.retrieve(accountId);
    try { await upsertStripeState(userId, acct); } catch (_) {}

    return res.json({
      has_account: true,
      charges_enabled: !!acct.charges_enabled,
      payouts_enabled: !!acct.payouts_enabled,
      details_submitted: !!acct.details_submitted,
    });
  } catch (e) {
    console.error("Stripe Connect status error:", e);
    return res.status(500).json({ error: "Failed to fetch Stripe account status" });
  }
});

/* ------------ OPTIONAL: webhook to keep stripe_connect in sync ------------- */
// Enable this if you want automatic updates after KYC completes.
// In Stripe Dashboard, point a webhook to /api/stripe-connect/webhook and set STRIPE_WEBHOOK_SECRET.

router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      if (!WEBHOOK_SECRET) {
        console.warn("[stripeconnect] No STRIPE_WEBHOOK_SECRET set; using unsafe payload (dev only).");
        event = req.body;
      } else {
        const sig = req.headers["stripe-signature"];
        event = Stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
      }
    } catch (err) {
      console.error("[webhook] signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === "account.updated") {
        const account = event.data.object;

        // Map Stripe acct -> user. Support both account_id/stripe_account_id, and fallback to users table.
        let userId = null;

        try {
          const { accountCol } = await detectStripeConnectSchema();
          const q = `
            SELECT user_id
              FROM stripe_connect
             WHERE ${accountCol} = $1
             LIMIT 1
          `;
          const { rows } = await db.query(q, [account.id]);
          userId = rows?.[0]?.user_id ?? null;
        } catch (_) {}

        if (!userId) {
          const { rows } = await db.query(
            `SELECT id FROM users WHERE stripe_account_id = $1 LIMIT 1`,
            [account.id]
          );
          userId = rows?.[0]?.id ?? null;
        }

        if (userId) {
          await upsertStripeState(userId, account);
          try { await recomputeCreatorActive(db, userId); } catch (_) {}
        }
      }
      res.json({ received: true });
    } catch (err) {
      console.error("[webhook handler] error:", err);
      res.status(500).end();
    }
  }
);

// TEMP: backfill business_profile.name on existing Stripe accounts
// Call this once (e.g. via Postman) then remove/disable.
router.post("/backfill-business-names", async (req, res) => {
  try {
    const stripe = getStripe();

    const { rows } = await db.query(`
      SELECT u.id,
             u.stripe_account_id,
             cp.display_name
        FROM users u
        JOIN creator_profiles cp ON cp.user_id = u.id
       WHERE u.stripe_account_id IS NOT NULL
    `);

    let updated = 0;

    for (const row of rows) {
      const displayName = row.display_name || `Sliptail Creator #${row.id}`;
      if (!row.stripe_account_id) continue;

      try {
        await stripe.accounts.update(row.stripe_account_id, {
          business_profile: {
            name: displayName,
            product_description: "Digital content and creator services from Sliptail",
          },
        });
        updated++;
      } catch (e) {
        console.error(
          "Failed to update Stripe account",
          row.stripe_account_id,
          e.message || e
        );
      }
    }

    res.json({ updated, total: rows.length });
  } catch (e) {
    console.error("backfill-business-names error:", e);
    res.status(500).json({ error: "Failed to backfill business_profile names" });
  }
});

module.exports = router;

