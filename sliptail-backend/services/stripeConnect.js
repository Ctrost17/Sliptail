const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Pull latest Stripe account flags and persist them.
 * - Writes to stripe_connect table
 * - Best-effort mirror to creator_profiles.stripe_charges_enabled (if exists)
 * Returns { account_id, details_submitted, charges_enabled, payouts_enabled }
 */
async function syncStripeForUser(db, userId) {
  // 1) find account id
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
  const charges_enabled   = !!acct.charges_enabled;
  const payouts_enabled   = !!acct.payouts_enabled;

  // 3) upsert into stripe_connect
  await db.query(
    `
    INSERT INTO stripe_connect (user_id, account_id, details_submitted, charges_enabled, payouts_enabled, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (user_id) DO UPDATE
       SET account_id        = EXCLUDED.account_id,
           details_submitted = EXCLUDED.details_submitted,
           charges_enabled   = EXCLUDED.charges_enabled,
           payouts_enabled   = EXCLUDED.payouts_enabled,
           updated_at        = NOW()
    `,
    [userId, accountId, details_submitted, charges_enabled, payouts_enabled]
  );

  // 4) optional mirror to creator_profiles (best-effort; ignore if column missing)
  try {
    await db.query(
      `UPDATE creator_profiles
          SET stripe_charges_enabled = $2,
              updated_at = NOW()
        WHERE user_id=$1`,
      [userId, charges_enabled]
    );
  } catch (_) {
    // If the column doesn't exist, that's fine—we rely on stripe_connect now.
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