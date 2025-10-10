const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const db = require("../db");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("Stripe not configured: missing STRIPE_SECRET_KEY");
  }
  return Stripe(key);
}

// Create or reuse a creator’s Stripe Connect account
router.post("/connect", async (req, res) => {
  const { userId } = req.body;

  try {
    // 1. Get the creator from the DB
    const result = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
    const user = result.rows[0];

    // 2. If they already have a Stripe account, return success
    if (user.stripe_account_id) {
      return res.json({ message: "Stripe account already set up" });
    }

    // 3. Create new Stripe Connect account
  const stripe = getStripe();
  const account = await stripe.accounts.create({
      type: "standard",
    });

    // 4. Save account ID to the database
    await db.query("UPDATE users SET stripe_account_id = $1 WHERE id = $2", [
      account.id,
      userId,
    ]);

    // 5. Generate the onboarding link
  const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: "http://localhost:5000/stripe-refresh",
      return_url: "http://localhost:5000/stripe-success",
      type: "account_onboarding",
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error("Stripe Connect error:", err);
    res.status(500).json({ error: "Stripe connection failed" });
  }
});

module.exports = router;