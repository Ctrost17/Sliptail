
require("dotenv").config();

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, ...rest] = a.slice(2).split("=");
      if (rest.length) {
        args[k] = rest.join("=");
      } else {
        const next = argv[i+1];
        if (next && !next.startsWith("--")) { args[k] = next; i++; }
        else { args[k] = true; }
      }
    }
  }
  return args;
}


(async () => {
  const args = parseArgs(process.argv);
  const key = process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || args.key;
  if (!key) throw new Error("Set STRIPE_API_KEY (or pass --key sk_test_...)");
  const stripe = require("stripe")(key);

  const buyerId   = args.buyer || args.buyer_id;
  const creatorId = args.creator || args.creator_id;
  const productId = args.product || args.product_id;
  if (!buyerId || !creatorId || !productId) {
    console.error("Usage: node scripts/create-sub.js --buyer 123 --creator 456 --product 789 [--price price_XXX] [--email me@test.com]");
    process.exit(1);
  }

  // ensure a price (create a fresh $2/month price if not provided)
  let priceId = args.price;
  let createdPriceId = null;
  if (!priceId) {
    const prod = await stripe.products.create({
      name: "Test Membership " + Date.now(),
    });
    const price = await stripe.prices.create({
      unit_amount: 200,
      currency: "usd",
      recurring: { interval: "month" },
      product: prod.id,
    });
    priceId = price.id;
    createdPriceId = price.id;
  }

  // customer & payment method
  const email = args.email || `test+{Date.now()}@example.com`;
  const customer = await stripe.customers.create({
    email
  });

  const pm = await stripe.paymentMethods.create({
    type: "card",
    card: { number: "4242424242424242", exp_month: 12, exp_year: 2030, cvc: "123" },
  });
  await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });

  // subscription with metadata your webhook expects
  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: priceId }],
    expand: ["latest_invoice.payment_intent"],
    metadata: {
      buyer_id: String(buyerId),
      creator_id: String(creatorId),
      product_id: String(productId)
    }
  });

  console.log(JSON.stringify({
    subscription_id: sub.id,
    status: sub.status,
    current_period_end: sub.current_period_end,
    cancel_at_period_end: sub.cancel_at_period_end,
    created_price_id: createdPriceId
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
