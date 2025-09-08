module.exports.recomputeCreatorActive = async function recomputeCreatorActive(db, userId) {
  const uid = String(userId || "").trim();

  if (!uid) {
    return { isActive: false, profileComplete: false, stripeConnected: false, hasPublishedProduct: false };
  }

  /* ---------- users.stripe_connected (highest priority) ---------- */
  let usersStripeConnected = false;
  try {
    const { rows } = await db.query(
      `
      SELECT
        CASE WHEN EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='users' AND column_name='stripe_connected'
        )
        THEN COALESCE(stripe_connected, false) ELSE false END AS stripe_connected
      FROM users
      WHERE id::text=$1
      LIMIT 1
      `,
      [uid]
    );
    usersStripeConnected = !!rows?.[0]?.stripe_connected;
  } catch (_) {}

  /* ---------- profile completeness ---------- */
  const { rows: profRows } = await db.query(
    `
    SELECT
      COALESCE(is_profile_complete, false) AS is_profile_complete,
      display_name, bio, profile_image,
      CASE WHEN to_regclass('public.creator_profile_photos') IS NOT NULL THEN
        (SELECT COUNT(*)::int FROM creator_profile_photos WHERE user_id::text=$1)
      ELSE 0 END AS photos_count,
      CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='creator_profiles' AND column_name='stripe_charges_enabled'
      )
      THEN COALESCE(stripe_charges_enabled, false)
      ELSE false
      END AS stripe_charges_enabled_cp
    FROM creator_profiles
    WHERE user_id::text=$1
    LIMIT 1
    `,
    [uid]
  );

  if (!profRows.length) {
    return { isActive: false, profileComplete: false, stripeConnected: false, hasPublishedProduct: false };
  }

  const p = profRows[0];
  let profileComplete = p.is_profile_complete === true
    ? true
    : (!!p.display_name && !!p.bio && !!p.profile_image && (Number(p.photos_count || 0) >= 4));

  /* ---------- stripe connectivity (priorities) ---------- */
  let stripeConnected = !!usersStripeConnected;

  if (!stripeConnected) stripeConnected = !!p.stripe_charges_enabled_cp;

  if (!stripeConnected) {
    const { rows: sc } = await db.query(
      `
      SELECT COALESCE(charges_enabled,false) AS charges_enabled,
             COALESCE(details_submitted,false) AS details_submitted
      FROM stripe_connect
      WHERE user_id::text=$1
      LIMIT 1
      `,
      [uid]
    );
    if (sc.length) stripeConnected = !!(sc[0].charges_enabled || sc[0].details_submitted);
  }

  if (!stripeConnected) {
    const { rows: u } = await db.query(
      `
      SELECT
        CASE WHEN EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='users' AND column_name='stripe_charges_enabled'
        ) THEN COALESCE(stripe_charges_enabled,false) ELSE false END AS charges_enabled,
        CASE WHEN EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='users' AND column_name='stripe_details_submitted'
        ) THEN COALESCE(stripe_details_submitted,false) ELSE false END AS details_submitted
      FROM users
      WHERE id::text=$1
      LIMIT 1
      `,
      [uid]
    );
    if (u.length) stripeConnected = !!(u[0].charges_enabled || u[0].details_submitted);
  }

  /* ---------- products: detect active column, then counts ---------- */
  let productsHasActive = false;
  try {
    const { rows: hc } = await db.query(
      `
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='products' AND column_name='active'
      LIMIT 1
      `
    );
    productsHasActive = hc.length > 0;
  } catch (_) {}

  let hasPublishedProduct = false;
  let totalProducts = 0;

  if (productsHasActive) {
    const { rows: hp } = await db.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN active=TRUE THEN 1 ELSE 0 END),0)::int AS published_count,
        COALESCE(COUNT(*),0)::int AS total_count
      FROM products
      WHERE user_id::text=$1
      `,
      [uid]
    );
    hasPublishedProduct = (hp?.[0]?.published_count || 0) > 0;
    totalProducts = hp?.[0]?.total_count || 0;
  } else {
    // No "active" column → treat “has any product” as satisfying the published gate
    const { rows: hp } = await db.query(
      `SELECT COALESCE(COUNT(*),0)::int AS total_count FROM products WHERE user_id::text=$1`,
      [uid]
    );
    totalProducts = hp?.[0]?.total_count || 0;
    hasPublishedProduct = totalProducts > 0;
  }

  /* ---------- final rule ---------- */
  // Your requirement: activate when profile ✓, stripe ✓, and (published OR has ≥1 product)
  const isActive = profileComplete && stripeConnected && (hasPublishedProduct || totalProducts > 0);

  // Persist creator_profiles.is_active
  try {
    await db.query(
      `UPDATE creator_profiles SET is_active=$2, updated_at=NOW() WHERE user_id::text=$1`,
      [uid, isActive]
    );
  } catch (_) {}

  // Flip role → 'creator' once the user owns any product
  if (totalProducts > 0) {
    try {
      await db.query(
        `UPDATE users SET role='creator', updated_at=NOW() WHERE id::text=$1 AND role <> 'creator'`,
        [uid]
      );
    } catch (e) {
      console.warn("[recomputeCreatorActive] role flip failed:", e.message || e);
    }
  }

  return { isActive, profileComplete, stripeConnected, hasPublishedProduct };
};
