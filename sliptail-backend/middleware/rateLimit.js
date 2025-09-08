// middleware/rateLimit.js
const rateLimit = require("express-rate-limit");

/**
 * Generic limiter: 300 requests / 15 minutes (per IP)
 * Use on most POST endpoints.
 */
const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Strict limiter: 20 requests / 15 minutes (per IP)
 * Use on sensitive endpoints: login, verify-email, checkout session, password reset.
 */
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later." },
});

/**
 * Super strict (optional): 5 req / 15m — for password reset request
 */
const superStrictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, please try again later." },
});

module.exports = { standardLimiter, strictLimiter, superStrictLimiter };