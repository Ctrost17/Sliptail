// middleware/agency.js
const db = require("../db");

async function agencyResolver(req, res, next) {
  try {
    const hostHeader = (req.headers.host || "").toLowerCase();
    const host = hostHeader.split(":")[0]; // strip port

    let agency = null;

    if (host) {
      // Try to match by domain first
      const { rows } = await db.query(
        "select * from agencies where primary_domain = $1 and is_active = true limit 1",
        [host]
      );
      agency = rows[0] || null;
    }

    // Fallback: Sliptail as default (slug = 'sliptail')
    if (!agency) {
      const { rows } = await db.query(
        "select * from agencies where slug = $1 limit 1",
        ["sliptail"]
      );
      agency = rows[0] || null;
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
