// routes/agencyAdmin.js
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Helper to ensure the current user can manage this agency
async function ensureAgencyAdmin(req, res) {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }

  if (!req.agency) {
    res.status(400).json({ error: "No agency context" });
    return false;
  }

  // Platform admin can manage any agency
  if (req.user.role === "admin") {
    return true;
  }

  // Agency admin must be linked to this agency as admin or owner
  if (req.user.role !== "agency_admin") {
    res.status(403).json({ error: "Not allowed" });
    return false;
  }

  const rel = await db.oneOrNone(
    `
      SELECT id
      FROM agency_creators
      WHERE agency_id = $1
        AND creator_user_id = $2
        AND role IN ('admin', 'owner')
    `,
    [req.agency.id, req.user.id]
  );

  if (!rel) {
    res.status(403).json({ error: "Not allowed for this agency" });
    return false;
  }

  return true;
}

/**
 * GET /api/agency/admin/creators
 * List creators for this agency
 */
router.get("/creators", requireAuth, async (req, res) => {
  try {
    const ok = await ensureAgencyAdmin(req, res);
    if (!ok) return;

    const creators = await db.manyOrNone(
      `
        SELECT
          u.id,
          u.email,
          u.username,
          cp.display_name,
          cp.is_active,
          cp.is_profile_complete,
          ac.role
        FROM agency_creators ac
        JOIN users u
          ON u.id = ac.creator_user_id
        LEFT JOIN creator_profiles cp
          ON cp.user_id = u.id
        WHERE ac.agency_id = $1
          AND ac.role <> 'admin'
        ORDER BY cp.created_at DESC NULLS LAST, u.created_at DESC
      `,
      [req.agency.id]
    );

    res.json({ ok: true, creators });
  } catch (err) {
    console.error("[agencyAdmin] GET /creators error:", err);
    res.status(500).json({ error: "Failed to load creators" });
  }
});

/**
 * POST /api/agency/admin/creators/invite
 * Body: { email, displayName }
 */
router.post("/creators/invite", requireAuth, async (req, res) => {
  try {
    const ok = await ensureAgencyAdmin(req, res);
    if (!ok) return;

    const { email, displayName } = req.body || {};
    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required" });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const safeDisplayName =
      typeof displayName === "string" && displayName.trim().length > 0
        ? displayName.trim()
        : null;

    const result = await db.tx(async (t) => {
      // 1) Find or create user
      let user = await t.oneOrNone(
        "SELECT * FROM users WHERE lower(email) = $1",
        [trimmedEmail]
      );

      let isNewUser = false;

      if (!user) {
        isNewUser = true;
        // Temporary password, user will set a new one on first login
        const tempPassword = crypto.randomBytes(16).toString("hex");
        const passwordHash = await bcrypt.hash(tempPassword, 10);

        user = await t.one(
          `
            INSERT INTO users (email, password_hash, role, email_verified, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, false, true, now(), now())
            RETURNING *
          `,
          [trimmedEmail, passwordHash, "creator"]
        );
      } else {
        // Upgrade plain user to creator if needed
        if (user.role === "user") {
          user = await t.one(
            `
              UPDATE users
              SET role = 'creator',
                  updated_at = now()
              WHERE id = $1
              RETURNING *
            `,
            [user.id]
          );
        }
      }

      // 2) Ensure creator profile exists and is tied to this agency
      let profile = await t.oneOrNone(
        "SELECT * FROM creator_profiles WHERE user_id = $1",
        [user.id]
      );

      if (!profile) {
        profile = await t.one(
          `
            INSERT INTO creator_profiles
              (user_id, display_name, agency_id, is_active, is_profile_complete, created_at, updated_at)
            VALUES
              ($1, $2, $3, false, false, now(), now())
            RETURNING *
          `,
          [user.id, safeDisplayName || trimmedEmail, req.agency.id]
        );
      } else if (profile.agency_id !== req.agency.id) {
        // If the profile exists but belongs to a different agency, move it
        profile = await t.one(
          `
            UPDATE creator_profiles
            SET agency_id = $1,
                updated_at = now()
            WHERE user_id = $2
            RETURNING *
          `,
          [req.agency.id, user.id]
        );
      }

      // 3) Ensure agency_creators link exists
      await t.none(
        `
          INSERT INTO agency_creators (agency_id, creator_user_id, role)
          VALUES ($1, $2, 'creator')
          ON CONFLICT (agency_id, creator_user_id)
          DO UPDATE SET role = EXCLUDED.role
        `,
        [req.agency.id, user.id]
      );

      // 4) Create an email_verify token so we can send them a setup link
      const token = crypto.randomBytes(32).toString("hex");

      await t.none(
        `
          INSERT INTO user_tokens (user_id, token, token_type, expires_at)
          VALUES ($1, $2, 'email_verify', now() + interval '7 days')
        `,
        [user.id, token]
      );

      // Build invite URL based on the current host (works for Sliptail and agencies)
      const hostHeader = (req.headers.host || "").split(":")[0];
      const protocol = req.protocol || "https";
      const baseUrl = `${protocol}://${hostHeader}`;
      const inviteUrl = `${baseUrl}/creators/complete-setup?token=${token}`;

      return {
        user,
        profile,
        isNewUser,
        inviteUrl,
      };
    });

    res.json({
      ok: true,
      message: "Creator invited",
      isNewUser: result.isNewUser,
      inviteUrl: result.inviteUrl,
      creator: {
        id: result.user.id,
        email: result.user.email,
        displayName: result.profile.display_name,
      },
    });
  } catch (err) {
    console.error("[agencyAdmin] POST /creators/invite error:", err);
    res.status(500).json({ error: "Failed to invite creator" });
  }
});

module.exports = router;
