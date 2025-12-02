// routes/agency.js
const express = require("express");
const router = express.Router();

router.get("/config", (req, res) => {
  const agency = req.agency;

  if (!agency) {
    return res.json({
      brandName: "Sliptail",
      logoUrl: "/sliptail-logofull.png",
      primaryColor: "#10b981",
      supportEmail: "info@sliptail.com",
      supportUrl: "/support",
      termsUrl: "/terms",
      privacyUrl: "/privacy",
      isSliptail: true,
    });
  }

  res.json({
    brandName: agency.brand_name || agency.name || "Sliptail",
    logoUrl: agency.logo_url || "/sliptail-logofull.png",
    primaryColor: agency.primary_color || "#10b981",
    supportEmail: agency.support_email || "info@sliptail.com",
    supportUrl: agency.support_url || "/support",
    termsUrl: agency.terms_url || "/terms",
    privacyUrl: agency.privacy_url || "/privacy",
    isSliptail: agency.slug === "sliptail",
  });
});

module.exports = router;