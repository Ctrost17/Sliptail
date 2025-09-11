// sliptail-backend/middleware/auth.js
const jwt = require("jsonwebtoken");
const db = require("../db");

function clearAuthCookie(res) {
  if (res.clearCookie) {
    try {
      res.clearCookie("token", { httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    } catch {}
  }
}

function normRole(v) {
  return String(v ?? "user").trim().toLowerCase();
}

async function requireAuth(req, res, next) {
  try {
    let token = null;

    // 1) Bearer token preferred
    const h = req.headers.authorization || "";
    if (h.startsWith("Bearer ")) token = h.slice(7);

    // 2) Fallback: cookie
    if (!token && req.cookies?.token) token = req.cookies.token;

    if (!token) {
      clearAuthCookie(res);
      return res.status(401).json({ error: "Unauthorized (no token)" });
    }

    // 3) Verify signature
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Accept both new (id) and legacy (userId) payloads
    const userId = payload.id ?? payload.userId;

    // 4) SOURCE OF TRUTH: ensure user still exists & is active
    const { rows } = await db.query(
      `SELECT id, email, role, email_verified_at, is_active
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [userId]
    );
    const u = rows[0];

    if (!u) {
      clearAuthCookie(res);
      return res.status(401).json({ error: "Session invalid" });
    }
    if (u.is_active === false) {
      clearAuthCookie(res);
      return res.status(401).json({ error: "Account inactive" });
    }

    // 5) Attach fresh DB-backed user (normalize + TRIM role)
    req.user = {
      id: u.id,
      email: u.email,
      role: normRole(u.role),
      email_verified_at: u.email_verified_at || null,
    };

    return next();
  } catch (e) {
    clearAuthCookie(res);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// Only creators
function requireCreator(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  if (normRole(req.user.role) !== "creator")
    return res.status(403).json({ error: "Creator access only" });
  next();
}

// Only admins
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  if (normRole(req.user.role) !== "admin")
    return res.status(403).json({ error: "Admin access only" });
  next();
}

module.exports = { requireAuth, requireCreator, requireAdmin };
