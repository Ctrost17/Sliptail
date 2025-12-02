const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Pull latest Stripe account flags and persist them.
 * - Writes to stripe_connect table (supports account_id or stripe_account_id)
 * - Best effort mirror to creator_profiles.stripe_charges_enabled (if exists)
 * Returns { account_id, details_submitted, charges_enabled, payouts_enabled }
 */
async function syncStripeForUser(db, userId) {
  // 1) find account id on users
  const { rows } = await db.query(
    `SELECT stripe_account_id FROM users WHERE id=$1 LIMIT 1`,
    [userId]
  );
  const accountId = rows[0]?.stripe_account_id;
  if (!accountId) {
    throw new Error("No Stripe account on file");
  }

  // 2) get latest from Stripe
  const acct = await stripe.accounts.retrieve(accountId);
  const details_submitted = !!acct.details_submitted;
  const charges_enabled = !!acct.charges_enabled;
  const payouts_enabled = !!acct.payouts_enabled;

  // 3) detect which account column we have in stripe_connect
  const { rows: cols } = await db.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='stripe_connect'
    `
  );

  const hasStripeAccountId = cols.some(c => c.column_name === "stripe_account_id");
  const hasAccountId = cols.some(c => c.column_name === "account_id");

  const accountCol = hasStripeAccountId
    ? "stripe_account_id"
    : hasAccountId
    ? "account_id"
    : null;

  if (!accountCol) {
    throw new Error(
      "stripe_connect table must have either 'stripe_account_id' or 'account_id' column"
    );
  }

  // 4) upsert into stripe_connect using the detected column
  await db.query(
    `
    INSERT INTO stripe_connect (user_id, ${accountCol}, details_submitted, charges_enabled, payouts_enabled, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (user_id) DO UPDATE
       SET ${accountCol}        = EXCLUDED.${accountCol},
           details_submitted = EXCLUDED.details_submitted,
           charges_enabled   = EXCLUDED.charges_enabled,
           payouts_enabled   = EXCLUDED.payouts_enabled,
           updated_at        = NOW()
    `,
    [String(userId), accountId, details_submitted, charges_enabled, payouts_enabled]
  );

  // 5) optional mirror to creator_profiles (best effort)
  try {
    await db.query(
      `
      UPDATE creator_profiles
         SET stripe_charges_enabled = $2,
             updated_at            = NOW()
       WHERE user_id = $1
      `,
      [userId, charges_enabled]
    );
  } catch (_) {
    // If the column does not exist, that is fine
  }

  return {
    account_id: accountId,
    details_submitted,
    charges_enabled,
    payouts_enabled,
  };
}

module.exports = {
  syncStripeForUser,
};
