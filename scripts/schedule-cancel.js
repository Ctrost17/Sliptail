
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
    console.error("Usage: node scripts/schedule-cancel.js --sub sub_XXXX [--in-min 2] [--at 2025-10-03T14:00:00-05:00]");
    process.exit(1);
  }

  let whenEpoch = null;
  if (args["in-min"]) {
    const mins = Math.max(1, parseInt(args["in-min"], 10));
    whenEpoch = Math.floor(Date.now()/1000) + mins*60;
  } else if (args.at) {
    whenEpoch = Math.floor(Date.parse(String(args.at))/1000);
  } else {
    whenEpoch = Math.floor(Date.now()/1000) + 120; // default 2 minutes from now
  }

  const sub = await stripe.subscriptions.update(subId, { cancel_at: whenEpoch });
  console.log(JSON.stringify({
    subscription_id: sub.id,
    status: sub.status,
    cancel_at: sub.cancel_at,
    cancel_at_iso: sub.cancel_at ? new Date(sub.cancel_at*1000).toISOString() : null
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
