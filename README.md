
# Stripe Test Kit (Local Subscription Cancel Flow)

This mini kit helps you create a **test-mode subscription**, schedule a **quick cancel**, and **verify** everything while forwarding Stripe webhooks to your local API.

## 0) Prereqs
- Node 18+
- Stripe CLI installed **or** a public URL/tunnel to your local API
- Your backend webhook mounted at: `POST /api/stripe/webhook` **with** `express.raw({ type: "application/json" })`

## 1) Install deps (in your project root)
```
npm i stripe dotenv
```

## 2) Forward webhooks to localhost (Stripe CLI)
Terminal A:
```
stripe login
stripe listen --forward-to http://localhost:5000/api/stripe/webhook
```
Copy the printed **signing secret** `whsec_...` and set it in the terminal where you run your API:
```
set STRIPE_WEBHOOK_SECRET=whsec_**************  # Windows cmd
$env:STRIPE_WEBHOOK_SECRET="whsec_***********"  # PowerShell
```
Run your API:
```
npm run dev  # or: node index.js
```

## 3) Create a test subscription mapped to your DB
Terminal B (Windows cmd):
```
set STRIPE_API_KEY=sk_test_********************************
node scripts/create-sub.js --buyer 123 --creator 456 --product 789
```
- Pass **your** DB ids for `buyer`, `creator`, and `product`.
- If you don’t pass `--price`, the script auto-creates a $2/mo price for Stripe.
- The subscription metadata includes `buyer_id`, `creator_id`, `product_id` so your webhook can upsert `memberships`.

## 4) Schedule a near-term cancel (so you can watch it expire)
```
node scripts/schedule-cancel.js --sub sub_XXXX --in-min 2
```
or at an exact time (Central Time example):
```
node scripts/schedule-cancel.js --sub sub_XXXX --at 2025-10-03T14:00:00-05:00
```

## 5) Verify
```
node scripts/check-sub.js --sub sub_XXXX
```
- When the time hits, Stripe emits `customer.subscription.updated`.
- With `stripe listen` running, your webhook updates the `memberships` row.
- Reload your Purchases page → the membership should disappear.

## Troubleshooting
- If the membership still shows, confirm:
  - Stripe sub is `status: "canceled"` (`check-sub.js`).
  - Your server logs show `[webhook] customer.subscription.updated`.
  - `STRIPE_WEBHOOK_SECRET` matches the current `stripe listen` output.
  - `/api/memberships/mine` SQL matches the access logic (exclude canceled/expired).

You can safely delete the auto-created Stripe price/product when done.
