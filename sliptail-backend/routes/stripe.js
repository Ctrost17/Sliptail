const express = require("express");
const router = express.Router();

/**
 * Deprecated legacy route for Express Connect.
 * We now use Standard Connect via /api/stripe-connect/create-link.
 */
router.post("/connect", (req, res) => {
  return res.status(410).json({
    error: "This endpoint is deprecated. Use /api/stripe-connect/create-link instead.",
  });
});

module.exports = router;
