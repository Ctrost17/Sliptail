const express = require("express");
const router = express.Router();

router.post("/logout", (req, res) => {
  // Clear cookies (use same options as when they were set)
  res.clearCookie("auth", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV !== "development",
    path: "/", // important: match the original path
  });

  // If you also issue a "token" cookie, clear that too
  res.clearCookie("token", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV !== "development",
    path: "/",
  });

  // Tell the client logout succeeded
  res.json({ ok: true });
});

module.exports = router;