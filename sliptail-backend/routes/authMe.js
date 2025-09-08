const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
router.get("/me", requireAuth, (req, res) => res.json(req.user));
module.exports = router;