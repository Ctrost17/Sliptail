const express = require('express');
const cors = require("cors");
const cookieParser = require("cookie-parser");              // <-- add
const path = require("path");               // <-- creator-status etc.
require("dotenv").config({ path: path.join(__dirname, ".env") });
const db = require('./db');

const authRoutes = require('./routes/auth');
const authLogoutRoutes = require('./routes/authLogout');
const checkoutRoutes = require('./routes/checkout');
const stripeRoutes = require('./routes/stripe');
const productRoutes = require('./routes/products');
const orderRoutes = require("./routes/orders");
const downloadRoutes = require("./routes/downloads");
const requestRoutes = require("./routes/requests");
const creatorDashboardRoutes = require("./routes/creatorDashboard");
const membershipRoutes = require("./routes/memberships");
const postRoutes = require("./routes/posts");
const creatorRoutes = require("./routes/creators");
const categoryRoutes = require("./routes/categories");
const homeRoutes = require("./routes/home");
const reviewRoutes = require("./routes/reviews");
const emailRoutes = require("./routes/email");
const settingsRoutes = require("./routes/settings");
const notificationRoutes = require("./routes/notifications");
const adminRoutes = require("./routes/admin");
const stripeConnectRoutes = require("./routes/stripeConnect");
const stripeCheckoutRoutes = require("./routes/stripeCheckout");
const stripeWebhook = require("./routes/stripeWebhook");
const meRoutes = require('./routes/me'); 
const FRONTEND = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");    

const passport = require("passport");
const cron = require("node-cron");
// const { notifyMembershipsExpiring } = require("./utils/notify"); // (replaced by job)
const runMembershipRenewalReminder = require("./jobs/membershipRenewalReminder");
const { notFound, errorHandler } = require("./middleware/error");
const { requireAuth } = require("./middleware/auth"); // <-- correct path
const app = express();

// If deploying behind a proxy/load balancer (Railway/Render/Heroku/Nginx/Cloudflare)
app.set("trust proxy", 1); // so secure cookies work

// Webhook MUST come before json parser (raw body)
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

// CORS: allow your frontend origin + credentials for cookies
app.use(cors({
  origin: FRONTEND,
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"], // <-- allow Bearer header
}));

// Ensure Express responds to preflight on all routes (fixes 404 on OPTIONS)
app.options(/.*/, cors());

app.use(cookieParser());                                    // <-- add
app.use(express.json({ limit: "25mb" }));

// Auth + OAuth
app.use(passport.initialize());
app.use('/api/auth', authRoutes);
app.use('/api/auth', require('./routes/authGoogle'));
app.use('/api/auth', authLogoutRoutes); // explicit logout route

// API routes
app.use('/api/stripe', stripeRoutes);
app.use('/api/products', productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/downloads", downloadRoutes);
app.use("/api/requests", requestRoutes);
app.use("/api/creator/dashboard", creatorDashboardRoutes);
app.use("/api/memberships", membershipRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/creators", creatorRoutes);
app.use("/api/creator", require("./routes/creator"));
app.use("/api/categories", categoryRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/email", emailRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/stripe-connect", stripeConnectRoutes);
app.use("/api/stripe-checkout", stripeCheckoutRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));

// Mount /api/me BEFORE notFound/errorHandler
app.use('/api/me', meRoutes);                               // <-- move up

// Health + test
app.get('/api/health', (req, res) => res.json({ message: '✅ Server is running!' }));
app.get('/test-db', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW()');
    res.json({ now: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 404 + error handlers LAST
app.use(notFound);
app.use(errorHandler);

/* ------------------------ Cron (Option A: node-cron) ------------------------ */
/**
 * Schedules the membership renewal reminder job to run every day at 09:00.
 * Enable it by setting either:
 *   ENABLE_CRON=1
 * or
 *   CRON_ENABLED=true
 * Optional timezone via CRON_TZ (defaults to UTC if not provided).
 */
const CRON_ENABLED =
  process.env.ENABLE_CRON === "1" || process.env.CRON_ENABLED === "true";

if (CRON_ENABLED) {
  const tz = process.env.CRON_TZ || "UTC";
  console.log(`[cron] Scheduling membership renewal reminder at 09:00 (${tz})`);
  cron.schedule(
    "0 9 * * *",
    async () => {
      try {
        const { processed, notified } = await runMembershipRenewalReminder();
        console.log(
          `[cron] membershipRenewalReminder done — processed=${processed} notified=${notified}`
        );
      } catch (e) {
        console.error("[cron] membershipRenewalReminder failed:", e);
      }
    },
    { timezone: tz }
  );
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});