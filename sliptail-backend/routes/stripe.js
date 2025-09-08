const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const db = require("../db");
require("dotenv").config();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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