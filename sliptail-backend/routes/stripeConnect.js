// routes/stripeConnect.js
const express = require("express");
const Stripe = require("stripe");
const db = require("../db");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { requireAuth } = require("../middleware/auth");
const { recomputeCreatorActive } = require("../services/creatorStatus");

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

// Optional: set this if you add the webhook below
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

/* ----------------------------- helpers ----------------------------- */

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
 * Creates (or reuses) a Stripe Express account and:
 *   - writes users.stripe_account_id
 *   - flips users.stripe_connected = TRUE (keeps your behavior)
 *   - returns onboarding link (if not finished) or login link (if finished)
 */
/**
 * POST /api/stripe-connect/create-link
 * Creates (or reuses) a Stripe Express account and:
 *   - writes users.stripe_account_id
 *   - flips users.stripe_connected = TRUE
 *   - returns onboarding link (if not finished) or login link (if finished)
 */
router.post("/create-link", requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    // 1) Load user, creator profile, and any existing connect account
    const { rows } = await db.query(
      `
      SELECT u.id,
             u.email,
             u.stripe_account_id,
             sc.account_id AS stripe_connect_account_id,
             cp.display_name
        FROM users u
        LEFT JOIN creator_profiles cp ON cp.user_id = u.id
        LEFT JOIN stripe_connect   sc ON sc.user_id = u.id
       WHERE u.id = $1
       LIMIT 1
      `,
      [userId]
    );

    const me = rows[0];
    if (!me) return res.status(404).json({ error: "User not found" });

    const displayName = me.display_name || `Sliptail Creator #${me.id}`;

    // Prefer users.stripe_account_id, but fall back to legacy stripe_connect.account_id
    let accountId =
      me.stripe_account_id || me.stripe_connect_account_id || null;

    const stripe = getStripe();

    // 2) If no account anywhere, create a fresh Express account
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: me.email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          name: displayName,
          product_description: "Digital content and creator services from Sliptail",
        },
      });

      accountId = account.id;

      // Store on users table for future reuse
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

      // Seed / update stripe_connect row
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
        console.warn("[create-link] seed stripe_connect warn:", seedErr.message || seedErr);
      }

      // Initial snapshot (flags may still be false until onboarding completes)
      try {
        await upsertStripeState(userId, account);
      } catch (_) {}

    } else if (!me.stripe_account_id && accountId) {
      // 3) Account exists only in stripe_connect → normalize into users table
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
    }

    // 4) Retrieve account from Stripe to decide onboarding vs. manage
    const acct = await stripe.accounts.retrieve(accountId);

    // Persist the latest flags into stripe_connect / creator_profiles
    try {
      await upsertStripeState(userId, acct);
    } catch (_) {}

    const needsOnboarding =
      !acct.details_submitted || !acct.charges_enabled || !acct.payouts_enabled;

    if (needsOnboarding) {
      const link = await stripe.accountLinks.create({
        account: accountId,
        type: "account_onboarding",
        refresh_url: `${FRONTEND_BASE}/creator/setup?refresh=1`,
        return_url: `${FRONTEND_BASE}/creator/setup?onboarded=1`,
      });
      return res.json({
        url: link.url,
        account_id: accountId,
        mode: "onboarding",
      });
    }

    // Already fully enabled → send them to Stripe dashboard
    const loginLink = await stripe.accounts.createLoginLink(accountId, {
      redirect_url: `${FRONTEND_BASE}/dashboard`,
    });
    return res.json({
      url: loginLink.url,
      account_id: accountId,
      mode: "manage",
    });
  } catch (e) {
    console.error("Stripe Connect create-link error:", e);
    return res.status(500).json({ error: "Failed to create Stripe account link" });
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

