
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

  const subId = args.sub || args.subscription || args.id;
  if (!subId) {
    console.error("Usage: node scripts/check-sub.js --sub sub_XXXX");
    process.exit(1);
  }

  const sub = await stripe.subscriptions.retrieve(subId);
  const payload = {
    subscription_id: sub.id,
    status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end,
    cancel_at: sub.cancel_at,
    cancel_at_iso: sub.cancel_at ? new Date(sub.cancel_at*1000).toISOString() : null,
    current_period_end: sub.current_period_end,
    current_period_end_iso: sub.current_period_end ? new Date(sub.current_period_end*1000).toISOString() : null,
    ended_at: sub.ended_at,
    ended_at_iso: sub.ended_at ? new Date(sub.ended_at*1000).toISOString() : null
  };
  console.log(JSON.stringify(payload, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
