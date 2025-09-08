const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');              // <-- add
require("dotenv").config();
const db = require('./db');

const authRoutes = require('./routes/auth');
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
const path = require("path");               // <-- creator-status etc.

const passport = require("passport");
const cron = require("node-cron");
const { notifyMembershipsExpiring } = require("./utils/notify");
const { notFound, errorHandler } = require("./middleware/error");

const app = express();

// If deploying behind a proxy/load balancer (Railway/Render/Heroku/Nginx/Cloudflare)
app.set('trust proxy', 1); // so secure cookies work

// Webhook MUST come before json parser (raw body)
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

// CORS: allow your frontend origin + credentials for cookies
app.use(cors({
  origin: FRONTEND,
  credentials: true,
    methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"], // <-- allow Bearer header
}));

app.use(cookieParser());                                    // <-- add
app.use(express.json({ limit: "25mb" }));

// Auth + OAuth
app.use(passport.initialize());
app.use('/api/auth', authRoutes);
app.use("/api/auth", require("./routes/authGoogle"));       // ok to share base path

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
app.use("/uploads", express.static(path.join(__dirname, "public", "uploads")));
app.use("/api/checkout", checkoutRoutes);

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

// Cron (optional)
if (process.env.CRON_ENABLED === "true") {
  cron.schedule("0 9 * * *", async () => {
    try {
      await notifyMembershipsExpiring({ days: 3 });
      console.log("Membership-expiring emails sent.");
    } catch (e) {
      console.error("Cron job failed:", e);
    }
  }, { timezone: process.env.CRON_TZ || "America/Chicago" });
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});