const db = require("../db");
const { enqueueAndSend } = require("./emailQueue");

/**
 * Create an in-app notification row (for the website bell).
 * Safe no-op on error (logs only).
 * type examples: 'purchase','product_sale','new_request','request_delivered','member_post','membership_expiring'
 */
async function notifyInApp(userId, { type, title, body, metadata }) {
  try {
    await db.query(
      `INSERT INTO notifications (user_id, type, title, body, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, type, title, body || null, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (e) {
    console.error("notifyInApp error:", e);
  }
}

/**
 * Send email IF the user's toggle allows it.
 * Kept your signature but added optional {text, replyTo}.
 */
async function sendIfUserPref(userId, prefKey, { subject, html, category, text, replyTo }) {
  try {
    const { rows } = await db.query(
      `SELECT email, ${prefKey} AS enabled FROM users WHERE id=$1`,
      [userId]
    );
    const u = rows[0];
    if (!u) return { skipped: "no_user" };
    if (!u.enabled) return { skipped: "pref_off" };
    await enqueueAndSend({ to: u.email, subject, html, category, text, replyTo });
    return { sent: true };
  } catch (e) {
    console.error("sendIfUserPref error:", e);
    return { error: e.message || String(e) };
  }
}

/**
 * Notify *only the members of the specific membership product* that this post belongs to.
 * Call with:
 *   notifyPostToMembers({ creatorId, productId, postId, title })
 */
async function notifyPostToMembers({ creatorId, productId, postId, title }) {
  try {
    if (!productId) {
      console.warn("notifyPostToMembers: missing productId — fanout skipped");
      return;
    }

    // Get membership product title for nice copy (fallbacks if missing)
    const { rows: prodRows } = await db.query(
      `SELECT id, title FROM products WHERE id=$1 LIMIT 1`,
      [productId]
    );
    const productTitle = prodRows?.[0]?.title || "your membership";

    // IMPORTANT: your memberships table does NOT have m.user_id; use buyer_id only
    const { rows: members } = await db.query(
      `
      SELECT DISTINCT m.buyer_id AS user_id
        FROM memberships m
       WHERE m.product_id = $1
         AND m.status IN ('active','trialing')
         AND (m.cancel_at_period_end IS FALSE OR m.cancel_at_period_end IS NULL)
         AND (m.current_period_end IS NULL OR NOW() <= m.current_period_end)
      `,
      [productId]
    );

    // Debug fan-out size (helps verify inserts after posting)
    console.log("[notifyPostToMembers] productId=%s eligible=%d", productId, members.length);

    if (!members.length) return;

    const tasks = members.map(({ user_id }) =>
      Promise.allSettled([
        // In-app (always stored) — IMPORTANT: type must be "member_post" to match frontend routing
        notifyInApp(user_id, {
          type: "member_post",
          title: "New content posted",
          body: `New content from ${productTitle} has just been posted. Check it out on My Purchases page!`,
          metadata: {
            creator_id: creatorId,
            product_id: productId,
            post_id: postId,
          },
        }),

        // Email (respect user setting)
        sendIfUserPref(user_id, "notify_post", {
          subject: `New content in ${productTitle}`,
          html: `<p>New content from <strong>${productTitle}</strong> has just been posted.</p>
                 <p>Check it out on your <a href="${process.env.FRONTEND_URL || ""}/purchases">My Purchases</a> page.</p>`,
          category: "membership_post",
        }),
      ])
    );

    await Promise.allSettled(tasks);
  } catch (e) {
    console.error("notifyPostToMembers error:", e);
  }
}

/**
 * Notify user + creator when a purchase (of any type) is paid.
 * If you mark paid via orders API or Stripe webhook, call this.
 */
async function notifyPurchase({ orderId }) {
  try {
    const { rows } = await db.query(
      `SELECT o.id AS order_id, o.buyer_id, o.amount,
              p.id AS product_id, p.title, p.product_type, p.user_id AS creator_id
         FROM orders o
         JOIN products p ON p.id = o.product_id
        WHERE o.id = $1`,
      [orderId]
    );
    const o = rows[0];
    if (!o) return;

    // fire both email + in-app for buyer
    await Promise.allSettled([
      sendIfUserPref(o.buyer_id, "notify_purchase", {
        subject: `Your ${o.product_type} purchase is confirmed`,
        html: `<p>Thanks! Your purchase of <strong>${o.title || "a product"}</strong> is confirmed.</p>
               <p>You can view/download it from your purchases page.</p>`,
        category: "purchase_receipt",
      }),
      notifyInApp(o.buyer_id, {
        type: "purchase",
        title: "Purchase confirmed",
        body: `Your ${o.product_type} "${o.title || "product"}" is confirmed.`,
        metadata: { order_id: o.order_id, product_id: o.product_id },
      }),
    ]);

    // fire both email + in-app for creator
    await Promise.allSettled([
      sendIfUserPref(o.creator_id, "notify_product_sale", {
        subject: `You made a sale 🎉`,
        html: `<p>Your ${o.product_type} "<strong>${o.title || "product"}</strong>" was just purchased.</p>`,
        category: "creator_sale",
      }),
      notifyInApp(o.creator_id, {
        type: "product_sale",
        title: "You made a sale 🎉",
        body: `Your ${o.product_type} "${o.title || "product"}" was purchased.`,
        metadata: { order_id: o.order_id, product_id: o.product_id },
      }),
    ]);
  } catch (e) {
    console.error("notifyPurchase error:", e);
  }
}

/**
 * Notify creator when a new request arrives (after user fills request form).
 * Call right after creating the request row.
 */
async function notifyCreatorNewRequest({ requestId }) {
  try {
    const { rows } = await db.query(
      `SELECT cr.id, cr.creator_id
         FROM custom_requests cr
        WHERE cr.id=$1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return;

    await Promise.allSettled([
      sendIfUserPref(r.creator_id, "notify_new_request", {
        subject: `New request received`,
        html: `<p>You received a new request. Visit your creator dashboard → requests.</p>`,
        category: "new_request",
      }),
      notifyInApp(r.creator_id, {
        type: "new_request",
        title: "New request received",
        body: "A buyer submitted a new request.",
        metadata: { request_id: r.id },
      }),
    ]);
  } catch (e) {
    console.error("notifyCreatorNewRequest error:", e);
  }
}

/**
 * Notify buyer when a request is delivered.
 * Call right after setting status='delivered'.
 */
async function notifyRequestDelivered({ requestId }) {
  try {
    const { rows } = await db.query(
      `SELECT cr.id, cr.buyer_id
         FROM custom_requests cr
        WHERE cr.id=$1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return;

    await Promise.allSettled([
      sendIfUserPref(r.buyer_id, "notify_request_completed", {
        subject: `Your request has been delivered`,
        html: `<p>Your request has been completed. You can download the delivery from your requests page.</p>`,
        category: "request_delivered",
      }),
      notifyInApp(r.buyer_id, {
        type: "request_delivered",
        title: "Your request has been delivered",
        body: "Open your requests page to download the file.",
        metadata: { request_id: r.id },
      }),
    ]);
  } catch (e) {
    console.error("notifyRequestDelivered error:", e);
  }
}

/**
 * Membership expiring reminder (run by a daily cron or manual job).
 * Notifies users whose membership period ends within N days.
 */
async function notifyMembershipsExpiring({ days = 3 } = {}) {
  try {
    const { rows } = await db.query(
      `SELECT m.id, m.buyer_id, m.creator_id, m.current_period_end,
              cp.display_name
         FROM memberships m
    LEFT JOIN creator_profiles cp ON cp.user_id = m.creator_id
        WHERE m.status IN ('active','trialing')
          AND m.current_period_end BETWEEN NOW() AND NOW() + ($1 || ' days')::interval`,
      [String(days)]
    );

    const tasks = rows.map((m) =>
      Promise.allSettled([
        sendIfUserPref(m.buyer_id, "notify_membership_expiring", {
          subject: `Your membership is ending soon`,
          html: `<p>Your membership with <strong>${m.display_name || "a creator"}</strong> ends on <strong>${new Date(
            m.current_period_end
          ).toLocaleString()}</strong>.</p>
                 <p>Renew to keep access.</p>`,
          category: "membership_expiring",
        }),
        notifyInApp(m.buyer_id, {
          type: "membership_expiring",
          title: "Membership ending soon",
          body: `Ends on ${new Date(m.current_period_end).toLocaleString()}.`,
          metadata: { membership_id: m.id, creator_id: m.creator_id },
        }),
      ])
    );

    await Promise.allSettled(tasks);
  } catch (e) {
    console.error("notifyMembershipsExpiring error:", e);
  }
}

module.exports = {
  // generic
  sendIfUserPref,

  // event helpers used by your routes
  notifyPostToMembers,
  notifyPurchase,
  notifyCreatorNewRequest,
  notifyRequestDelivered,
  notifyMembershipsExpiring,
};
