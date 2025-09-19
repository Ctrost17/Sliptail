const Stripe = require("stripe");
const db = require("../db");
const { notifyPurchase } = require("../utils/notify");
const { recomputeCreatorActive } = require("../services/creatorStatus");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// If you use ONE webhook endpoint for everything, keep STRIPE_WEBHOOK_SECRET.
// If you created a *separate* Connect webhook endpoint in Stripe Dashboard, you can
// optionally put its secret in STRIPE_CONNECT_WEBHOOK_SECRET and keep using ?connect=1.
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const connectEndpointSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;

/* ----------------------------- helpers ----------------------------- */

/** Ensure idempotency table exists (safe to run repeatedly). */
async function ensureWebhookDedupTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS processed_webhook_events (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/** Ensure stripe_connect table (new-column shape). If your table already exists with a legacy shape, we adapt at runtime. */
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
    .catch(() => {});
}

/** Detect actual stripe_connect schema to support legacy columns. */
async function detectStripeConnectSchema() {
  const { rows } = await db.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='stripe_connect'
  `);

  const hasStripeAccountId = rows.some(r => r.column_name === "stripe_account_id");
  const hasAccountId = rows.some(r => r.column_name === "account_id");
  const accountCol = hasStripeAccountId ? "stripe_account_id" : (hasAccountId ? "account_id" : null);

  const userCol = rows.find(r => r.column_name === "user_id");
  const userIsInteger = !!userCol && /integer/.test(userCol.data_type);

  const hasConnectedAt = rows.some(r => r.column_name === "connected_at");

  if (!accountCol) {
    throw new Error("stripe_connect table must have either 'stripe_account_id' or 'account_id' column");
  }

  return { accountCol, userIsInteger, hasConnectedAt };
}

/**
 * Persist latest Stripe Connect flags for a user (schema-adaptive):
 * - Upsert into stripe_connect
 * - Best-effort mirror to creator_profiles.stripe_charges_enabled (if column exists)
 * - Best-effort snapshot to users.stripe_* columns (if those exist)
 */
async function upsertStripeState(userId, account) {
  const uid = String(userId);
  const accountId = account?.id || null;
  const details_submitted = !!account?.details_submitted;
  const charges_enabled   = !!account?.charges_enabled;
  const payouts_enabled   = !!account?.payouts_enabled;

  await ensureStripeConnectTable();
  const { accountCol, userIsInteger, hasConnectedAt } = await detectStripeConnectSchema();

  const userParam = userIsInteger ? "CAST($1 AS integer)" : "$1";

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

  await db.query(
    `
    INSERT INTO stripe_connect (${insertCols.join(", ")})
    VALUES (${insertValsSql.join(", ")})
    ON CONFLICT (user_id) DO UPDATE
      SET ${setPairs.join(", ")}
    `,
    [uid, accountId, details_submitted, charges_enabled, payouts_enabled]
  );

  // Mirror to creator_profiles.stripe_charges_enabled if column exists (legacy compatibility)
  try {
    const { rows: hasCol } = await db.query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='creator_profiles' AND column_name='stripe_charges_enabled'
        LIMIT 1`
    );
    if (hasCol.length) {
      await db.query(
        `INSERT INTO creator_profiles (user_id, stripe_charges_enabled, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET stripe_charges_enabled = EXCLUDED.stripe_charges_enabled,
               updated_at = NOW()`,
        [uid, charges_enabled]
      );
    }
  } catch (e) {
    console.warn("[webhook] mirror to creator_profiles failed:", e.message || e);
  }

  // Snapshot to users.stripe_* if those columns exist
  try {
    const { rows: hasUsersCols } = await db.query(`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='stripe_details_submitted') AS has_details,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='stripe_charges_enabled')   AS has_charges,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='stripe_payouts_enabled')   AS has_payouts
    `);
    const hc = hasUsersCols[0] || {};
    if (hc.has_details || hc.has_charges || hc.has_payouts) {
      const sets = [];
      const vals = [];
      let i = 1;

      if (hc.has_details) { sets.push(`stripe_details_submitted=$${i++}`); vals.push(details_submitted); }
      if (hc.has_charges) { sets.push(`stripe_charges_enabled=$${i++}`);   vals.push(charges_enabled); }
      if (hc.has_payouts) { sets.push(`stripe_payouts_enabled=$${i++}`);   vals.push(payouts_enabled); }

      if (sets.length) {
        vals.push(uid);
        await db.query(
          `UPDATE users SET ${sets.join(", ")}, updated_at=NOW() WHERE id::text=$${i}`,
          vals
        );
      }
    }
  } catch (e) {
    console.warn("[webhook] snapshot to users.stripe_* failed:", e.message || e);
  }

  return { account_id: accountId, details_submitted, charges_enabled, payouts_enabled };
}

/**
 * Ensure an orders row exists and is PAID for a checkout session (mode=payment).
 * Returns the orderId (existing or newly inserted).
 */
async function upsertPaidOrderFromSession(session) {
  const meta = session.metadata || {};
  const sessionId = session.id;
  const paymentIntentId = session.payment_intent || null;
  const amountCents = Number.isFinite(session.amount_total) ? Number(session.amount_total) : 0;

  // Prefer metadata if present (these are set in stripeCheckout.js)
  const orderIdFromMeta = meta.order_id ? parseInt(meta.order_id, 10) : null;
  const buyerId = meta.buyer_id ? parseInt(meta.buyer_id, 10) : null;
  const productId = meta.product_id ? parseInt(meta.product_id, 10) : null;

  // 1) Try to mark an existing pending order as paid and set the session id
  if (orderIdFromMeta) {
    const { rowCount } = await db.query(
      `UPDATE public.orders
          SET status='paid',
              stripe_payment_intent_id=$1,
              stripe_checkout_session_id=COALESCE(stripe_checkout_session_id, $2)
        WHERE id=$3 AND status IN ('pending','created')
      `,
      [paymentIntentId, sessionId, orderIdFromMeta]
    );
    if (rowCount > 0) {
      return orderIdFromMeta;
    }
  }

  // 2) If no existing row, insert a new PAID order (idempotent-ish by session id)
  // Try to find by session id first (if we processed earlier)
  const { rows: existing } = await db.query(
    `SELECT id FROM public.orders WHERE stripe_checkout_session_id = $1 LIMIT 1`,
    [sessionId]
  );
  if (existing.length) {
    return existing[0].id;
  }

  // Insert only if we have the minimal data
  const insertableBuyer = Number.isFinite(buyerId) ? buyerId : null;
  const insertableProduct = Number.isFinite(productId) ? productId : null;
  const insertableAmount = Number.isFinite(amountCents) ? amountCents : 0;

  const { rows: inserted } = await db.query(
    `
    INSERT INTO public.orders
      (buyer_id, product_id, amount_cents, stripe_payment_intent_id, status, created_at, stripe_checkout_session_id)
    VALUES
      ($1, $2, $3, $4, 'paid', NOW(), $5)
    RETURNING id
    `,
    [insertableBuyer, insertableProduct, insertableAmount, paymentIntentId, sessionId]
  );

  return inserted[0].id;
}

/* ----------------------------- handler ----------------------------- */
/**
 * Export a single handler function.
 * index.js must mount it with express.raw(...) already:
 *   app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook)
 */
module.exports = async function stripeWebhook(req, res) {
  let event;

  // 1) Verify Stripe signature (req.body is a Buffer thanks to express.raw)
  try {
    const sig = req.headers["stripe-signature"];
    const secretToUse =
      (connectEndpointSecret && req.query?.connect === "1")
        ? connectEndpointSecret
        : endpointSecret;

    event = stripe.webhooks.constructEvent(req.body, sig, secretToUse);
  } catch (err) {
    console.error("⚠️  Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2) De-duplicate events (Stripe can retry)
  try {
    await ensureWebhookDedupTable();
    const evId = event.id;
    const { rows } = await db.query(
      `INSERT INTO processed_webhook_events (id)
       VALUES ($1)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [evId]
    );
    if (!rows.length) {
      // already processed
      return res.status(200).end();
    }
  } catch (e) {
    console.error("Webhook de-dup insert failed (continuing):", e);
    // Proceed anyway; better to process than drop.
  }

  // 3) Handle relevant events
  try {
    switch (event.type) {
      /* ----------------- CONNECT: account state ----------------- */
      case "account.updated": {
        const account = event.data.object; // Stripe account
        const acctId = account.id;

        // Map Stripe account -> our user via stripe_connect (any schema) or users fallback
        let userId = null;
        try {
          const { accountCol } = await detectStripeConnectSchema();
          const { rows } = await db.query(
            `SELECT user_id FROM stripe_connect WHERE ${accountCol} = $1 LIMIT 1`,
            [acctId]
          );
          userId = rows?.[0]?.user_id ?? null;
        } catch (_) {}

        if (!userId) {
          const { rows } = await db.query(
            `SELECT id FROM users WHERE stripe_account_id = $1 LIMIT 1`,
            [acctId]
          );
          userId = rows?.[0]?.id ?? null;
        }

        if (userId) {
          await upsertStripeState(userId, account);
          try { await recomputeCreatorActive(db, userId); } catch (_) {}
        } else {
          // Not necessarily an error: account may not be linked yet.
          console.log("[account.updated] No matching user for account", acctId);
        }
        break;
      }

      /* ----------------- Checkout → Orders / Subscriptions ----------------- */
      case "checkout.session.completed": {
        const session = event.data.object;

        if (session.mode === "payment") {
          // one-time purchase/request
          const orderId = await upsertPaidOrderFromSession(session);
          try {
            await notifyPurchase({ orderId });
          } catch (e) {
            console.warn("notifyPurchase failed (non-fatal):", e);
          }
        }

        if (session.mode === "subscription") {
          const customer = session.customer;
          const buyerId = session.metadata?.buyer_id && parseInt(session.metadata.buyer_id, 10);
          if (customer && buyerId) {
            await db.query(
              `UPDATE users
                 SET stripe_customer_id=$1
               WHERE id=$2 AND (stripe_customer_id IS NULL OR stripe_customer_id <> $1)`,
              [customer, buyerId]
            );
          }
        }
        break;
      }

      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const orderId = pi.metadata?.order_id && parseInt(pi.metadata.order_id, 10);
        const sessionId = pi.metadata?.stripe_checkout_session_id || null; // may or may not exist

        if (orderId) {
          await db.query(
            `UPDATE orders
                SET status='paid',
                    stripe_payment_intent_id=$1,
                    stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $2)
              WHERE id=$3 AND status <> 'paid'`,
            [pi.id, sessionId, orderId]
          );
          try {
            await notifyPurchase({ orderId });
          } catch (e) {
            console.warn("notifyPurchase failed (non-fatal):", e);
          }
        }
        break;
      }

      /* ----------------- Subscription lifecycle → memberships ----------------- */
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const status = sub.status; // trialing, active, past_due, canceled, etc.
        
        // Calculate proper period end - handle invalid or missing timestamps
        let currentPeriodEnd;
        if (sub.current_period_end && sub.current_period_end > 0) {
          currentPeriodEnd = new Date(sub.current_period_end * 1000);
        } else {
          // Fallback: 1 month from now if Stripe doesn't provide valid period end
          currentPeriodEnd = new Date();
          currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
        }

        const meta = sub.metadata || {};
        const buyerId   = meta.buyer_id && parseInt(meta.buyer_id, 10);
        const creatorId = meta.creator_id && parseInt(meta.creator_id, 10);
        const productId = meta.product_id && parseInt(meta.product_id, 10);

        if (buyerId && creatorId && productId) {
          if (event.type === "customer.subscription.deleted") {
            await db.query(
              `UPDATE memberships
                  SET status='canceled',
                      current_period_end=$1
                WHERE stripe_subscription_id=$2`,
              [currentPeriodEnd, sub.id]
            );
          } else {
            await db.query(
              `INSERT INTO memberships
                 (buyer_id, creator_id, product_id, stripe_subscription_id, status, current_period_end, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,NOW())
               ON CONFLICT (stripe_subscription_id) DO UPDATE
                 SET status=EXCLUDED.status,
                     current_period_end=EXCLUDED.current_period_end`,
              [buyerId, creatorId, productId, sub.id, status, currentPeriodEnd]
            );
          }
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          const status = sub.status;
          
          // Calculate proper period end - handle invalid or missing timestamps
          let currentPeriodEnd;
          if (sub.current_period_end && sub.current_period_end > 0) {
            currentPeriodEnd = new Date(sub.current_period_end * 1000);
          } else {
            // Fallback: 1 month from now if Stripe doesn't provide valid period end
            currentPeriodEnd = new Date();
            currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + 1);
          }
          
          await db.query(
            `UPDATE memberships
                SET status=$1,
                    current_period_end=$2
              WHERE stripe_subscription_id=$3`,
            [status, currentPeriodEnd, subId]
          );
        }
        break;
      }

      default:
        // other events are fine to ignore
        break;
    }
  } catch (e) {
    console.error("Webhook handling error:", e);
    // tell Stripe to retry
    return res.status(500).send("webhook handler error");
  }

  // 4) Always ACK
  res.json({ received: true });
};