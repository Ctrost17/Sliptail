// creatorStatus.js
//
// Schema-aware recompute that never references missing tables/columns.
// Works across environments where some Stripe or profile fields may not exist.

async function tableExists(db, table) {
  const { rows } = await db.query(
    `SELECT to_regclass($1) IS NOT NULL AS ok`,
    [`public.${table}`]
  );
  return !!rows?.[0]?.ok;
}

async function columnExists(db, table, column) {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS ok`,
    [table, column]
  );
  return !!rows?.[0]?.ok;
}

module.exports.recomputeCreatorActive = async function recomputeCreatorActive(db, userId) {
  const uid = String(userId || "").trim();
  if (!uid) {
    return {
      isActive: false,
      profileComplete: false,
      stripeConnected: false,
      hasPublishedProduct: false,
    };
  }

  /* ---------- detect tables we will touch ---------- */
  const hasUsers           = await tableExists(db, "users");
  const hasProfiles        = await tableExists(db, "creator_profiles");
  const hasProfilePhotos   = await tableExists(db, "creator_profile_photos");
  const hasStripeConnect   = await tableExists(db, "stripe_connect");
  const hasProducts        = await tableExists(db, "products");

  /* ---------- users.stripe_connected (highest priority if present) ---------- */
  let usersStripeConnected = false;
  if (hasUsers && await columnExists(db, "users", "stripe_connected")) {
    try {
      const { rows } = await db.query(
        `SELECT COALESCE(stripe_connected,false) AS stripe_connected
         FROM users
         WHERE id::text=$1
         LIMIT 1`,
        [uid]
      );
      usersStripeConnected = !!rows?.[0]?.stripe_connected;
    } catch (_) { /* noop */ }
  }

  /* ---------- profile completeness ---------- */
  let displayName = null;
  let bio = null;
  let profileImage = null;
  let photosCount = 0;
  let profileCompleteFlag = false;

  if (hasProfiles) {
    // Only select columns that exist
    const sel = [];
    if (await columnExists(db, "creator_profiles", "is_profile_complete")) sel.push("is_profile_complete");
    if (await columnExists(db, "creator_profiles", "display_name"))       sel.push("display_name");
    if (await columnExists(db, "creator_profiles", "bio"))                sel.push("bio");
    if (await columnExists(db, "creator_profiles", "profile_image"))      sel.push("profile_image");

    if (sel.length) {
      const { rows } = await db.query(
        `SELECT ${sel.join(", ")}
         FROM creator_profiles
         WHERE user_id::text=$1
         LIMIT 1`,
        [uid]
      );
      if (rows.length) {
        const r = rows[0];
        profileCompleteFlag = ("is_profile_complete" in r) ? !!r.is_profile_complete : false;
        displayName  = ("display_name"  in r) ? r.display_name  : null;
        bio          = ("bio"            in r) ? r.bio          : null;
        profileImage = ("profile_image"  in r) ? r.profile_image: null;
      }
    }
  }

  if (hasProfilePhotos) {
    const { rows } = await db.query(
      `SELECT COALESCE(COUNT(*),0)::int AS cnt
       FROM creator_profile_photos
       WHERE user_id::text=$1`,
      [uid]
    );
    photosCount = rows?.[0]?.cnt || 0;
  }

  // Compute profileComplete if the explicit flag isn't present/true
  const profileComplete = profileCompleteFlag === true
    ? true
    : (!!displayName && !!bio && !!profileImage && photosCount >= 4);

  /* ---------- stripe connectivity (priorities) ---------- */
  let stripeConnected = !!usersStripeConnected;

  // creator_profiles.* stripe flags (legacy) if present — do NOT reference unknown columns
  if (!stripeConnected && hasProfiles) {
    let anyCpFlag = false;
    const cpFlags = [];

    if (await columnExists(db, "creator_profiles", "stripe_charges_enabled")) {
      cpFlags.push("COALESCE(stripe_charges_enabled,false)");
      anyCpFlag = true;
    }
    if (await columnExists(db, "creator_profiles", "stripe_details_submitted")) {
      cpFlags.push("COALESCE(stripe_details_submitted,false)");
      anyCpFlag = true;
    }

    if (anyCpFlag) {
      const { rows } = await db.query(
        `SELECT (${cpFlags.join(" OR ")}) AS ok
         FROM creator_profiles
         WHERE user_id::text=$1
         LIMIT 1`,
        [uid]
      );
      stripeConnected = !!rows?.[0]?.ok;
    }
  }

  // stripe_connect.* (canonical) if present
  if (!stripeConnected && hasStripeConnect) {
    const flags = [];
    if (await columnExists(db, "stripe_connect", "charges_enabled"))     flags.push("COALESCE(charges_enabled,false)");
    if (await columnExists(db, "stripe_connect", "payouts_enabled"))     flags.push("COALESCE(payouts_enabled,false)");
    if (await columnExists(db, "stripe_connect", "details_submitted"))   flags.push("COALESCE(details_submitted,false)");
    // Legacy name sometimes seen; include only if it exists:
    if (await columnExists(db, "stripe_connect", "stripe_charges_enabled")) flags.push("COALESCE(stripe_charges_enabled,false)");

    if (flags.length) {
      const { rows } = await db.query(
        `SELECT (${flags.join(" OR ")}) AS ok
         FROM stripe_connect
         WHERE user_id::text=$1
         ORDER BY id DESC
         LIMIT 1`,
        [uid]
      );
      stripeConnected = !!rows?.[0]?.ok;
    }
  }

  // users.* legacy stripe flags, if present
  if (!stripeConnected && hasUsers) {
    const flags = [];
    if (await columnExists(db, "users", "stripe_charges_enabled"))       flags.push("COALESCE(stripe_charges_enabled,false)");
    if (await columnExists(db, "users", "stripe_details_submitted"))     flags.push("COALESCE(stripe_details_submitted,false)");
    if (flags.length) {
      const { rows } = await db.query(
        `SELECT (${flags.join(" OR ")}) AS ok
         FROM users
         WHERE id::text=$1
         LIMIT 1`,
        [uid]
      );
      stripeConnected = !!rows?.[0]?.ok;
    }
  }

  /* ---------- products: detect "active" (or fallback) ---------- */
  let hasPublishedProduct = false;
  let totalProducts = 0;

  if (hasProducts) {
    const hasActive = await columnExists(db, "products", "active");
    if (hasActive) {
      const { rows } = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN active=TRUE THEN 1 ELSE 0 END),0)::int AS published_count,
           COALESCE(COUNT(*),0)::int AS total_count
         FROM products
         WHERE user_id::text=$1`,
        [uid]
      );
      hasPublishedProduct = (rows?.[0]?.published_count || 0) > 0;
      totalProducts = rows?.[0]?.total_count || 0;
    } else {
      const { rows } = await db.query(
        `SELECT COALESCE(COUNT(*),0)::int AS total_count
         FROM products
         WHERE user_id::text=$1`,
        [uid]
      );
      totalProducts = rows?.[0]?.total_count || 0;
      hasPublishedProduct = totalProducts > 0; // no "active" flag → treat "has any" as published enough
    }
  }

  /* ---------- final rule ---------- */
  // Activate when: profile complete AND stripe connected AND (has published OR has any product)
  const isActive = profileComplete && stripeConnected && (hasPublishedProduct || totalProducts > 0);

  /* ---------- persist flags only if columns exist ---------- */
  if (hasProfiles) {
    // is_active
    if (await columnExists(db, "creator_profiles", "is_active")) {
      const touchUpdatedAt = await columnExists(db, "creator_profiles", "updated_at");
      const set = [`is_active=$2`];
      if (touchUpdatedAt) set.push(`updated_at=NOW()`);
      try {
        await db.query(
          `UPDATE creator_profiles SET ${set.join(", ")} WHERE user_id::text=$1`,
          [uid, isActive]
        );
      } catch (_) { /* noop */ }
    }
    // is_profile_complete (if we derived it and the column exists)
    if (await columnExists(db, "creator_profiles", "is_profile_complete")) {
      try {
        await db.query(
          `UPDATE creator_profiles
           SET is_profile_complete=$2${(await columnExists(db, "creator_profiles", "updated_at")) ? ", updated_at=NOW()" : ""}
           WHERE user_id::text=$1`,
          [uid, profileComplete]
        );
      } catch (_) { /* noop */ }
    }
  }

  // Flip role → 'creator' once the user owns any product (if users table/columns exist)
  if (hasUsers && totalProducts > 0 && await columnExists(db, "users", "role")) {
    const touchUserUpdated = await columnExists(db, "users", "updated_at");
    try {
      await db.query(
        `UPDATE users
         SET role='creator'${touchUserUpdated ? ", updated_at=NOW()" : ""}
         WHERE id::text=$1 AND role <> 'creator'`,
        [uid]
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[recomputeCreatorActive] role flip failed:", e.message || e);
    }
  }

  return { isActive, profileComplete, stripeConnected, hasPublishedProduct };
};
