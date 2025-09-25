// jobs/membershipRenewalReminder.js
//
// Run this once a day (e.g., via cron, pm2, or a worker).
// It finds memberships that renew in 3 days and sends an in-app notification:
//
//  Title: "Heads up: Membership renewal soon"
//  Body:  "Heads up: Your membership (<product title>) will renew in 3 days!
//          No action needed unless you'd like to make changes."
//
// Deduping: we skip if a "membership_renewal" notification for the same
// (membership_id) was already created in the last 30 days.

const db = require("../db");
const { notify } = require("../services/notifications");
const { sendIfUserPref } = require("../utils/notify");
const { buildActionUrl } = require("../emails/mailer");
const T = require("../emails/templates");

/* --------------------- small schema helpers --------------------- */
async function hasTable(table) {
  const { rows } = await db.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema='public' AND table_name=$1
      LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

async function hasColumn(table, column) {
  const { rows } = await db.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2
      LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

/* --------------------------- main job --------------------------- */
async function runMembershipRenewalReminder() {
  // Fast out if tables aren’t present
  if (!(await hasTable("memberships")) || !(await hasTable("products"))) {
    console.warn("[membershipRenewalReminder] Skipping: memberships/products table missing");
    return { processed: 0, notified: 0 };
  }

  const hasBuyerId = await hasColumn("memberships", "buyer_id"); // else it's "user_id"
  const buyerExpr = hasBuyerId ? "COALESCE(m.buyer_id, m.user_id)" : "m.user_id";

  const hasCancelAt = await hasColumn("memberships", "cancel_at_period_end");
  const hasCurrentEnd = await hasColumn("memberships", "current_period_end");

  // If current_period_end is missing, there’s nothing sensible to do
  if (!hasCurrentEnd) {
    console.warn("[membershipRenewalReminder] Skipping: memberships.current_period_end missing");
    return { processed: 0, notified: 0 };
  }

  // Build dynamic WHERE fragments
  const where = [
    `m.status IN ('active','trialing')`,
    // Renewing "in 3 days" (date-based, UTC-safe)
    `DATE(m.current_period_end AT TIME ZONE 'UTC') = DATE((NOW() AT TIME ZONE 'UTC') + INTERVAL '3 days')`,
  ];
  if (hasCancelAt) {
    where.push(`m.cancel_at_period_end = FALSE`);
  }

  // Optional dedupe against notifications table if it exists
  const notifTableExists = await hasTable("notifications");
  const notifHasMetadata = notifTableExists && (await hasColumn("notifications", "metadata"));
  const notifJoin = notifTableExists
    ? `
      LEFT JOIN notifications n
        ON n.user_id = ${buyerExpr}
       AND n.type = 'membership_renewal'
       ${notifHasMetadata ? `AND (n.metadata->>'membership_id') = m.id::text` : ""}
       AND n.created_at > NOW() - INTERVAL '30 days'
    `
    : "";
  const notifWhere = notifTableExists ? `AND n.id IS NULL` : "";

  // Pull memberships that meet the criteria and haven’t been notified recently
  const sql = `
    SELECT
      m.id                              AS membership_id,
      ${buyerExpr}                      AS user_id,
      m.product_id,
      m.current_period_end,
      p.title                           AS product_title
    FROM memberships m
    JOIN products p ON p.id = m.product_id
    ${notifJoin}
    WHERE ${where.join(" AND ")}
    ${notifWhere}
  `;

  const { rows } = await db.query(sql);
  let notified = 0;

  for (const m of rows) {
    const userId = m.user_id;
    if (!userId) continue;

    try {
        // Build the Purchases link and email content
        const purchasesUrl = buildActionUrl("purchases");
        const msg = T.userMembershipRenewsSoon({ purchasesUrl });

        await Promise.allSettled([
    // Email (respects users.notify_membership_expiring toggle)
        sendIfUserPref(userId, "notify_membership_expiring", {
           subject: msg.subject,
            html: msg.html,
           text: msg.text,
          }),

      notify(
      userId,
      "membership_renewal",
      "Heads up: Membership renewal soon",
      `Heads up: Your membership (${m.product_title}) will renew in 3 days! No action needed unless you'd like to make changes.`,
      {
        membership_id: String(m.membership_id),
        product_id: String(m.product_id),
        period_end: m.current_period_end,
      }
    ),
   ]);
   
      notified++;
    } catch (e) {
      console.warn(
        "[membershipRenewalReminder] notify failed",
        { membership_id: m.membership_id, user_id: userId },
        e?.message || e
      );
    }
  }

  return { processed: rows.length, notified };
}

/* ------------- allow running directly (node this-file.js) ------------- */
if (require.main === module) {
  runMembershipRenewalReminder()
    .then((res) => {
      console.log(
        `[membershipRenewalReminder] done — processed=${res.processed} notified=${res.notified}`
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("[membershipRenewalReminder] error", err);
      process.exit(1);
    });
}

module.exports = runMembershipRenewalReminder;
