// middleware/agency.js
const db = require("../db");

async function agencyResolver(req, res, next) {
  try {
    const hostHeader = (req.headers.host || "").toLowerCase();
    const host = hostHeader.split(":")[0]; // strip port

    let agency = null;

    if (host) {
      // Try to match by domain first
      agency = await db.oneOrNone(
        "select * from agencies where primary_domain = $1 and is_active = true",
        [host]
      );
    }

    // Fallback: Sliptail as default (slug = 'sliptail')
    if (!agency) {
      agency = await db.oneOrNone(
        "select * from agencies where slug = $1",
        ["sliptail"]
      );
    }

    req.agency = agency;
    next();
  } catch (err) {
    console.error("agencyResolver error", err);
    req.agency = null;
    next();
  }
}

module.exports = { agencyResolver };
