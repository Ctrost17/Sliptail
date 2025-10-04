const db = require("../db");
const { sendEmail, buildActionUrl } = require("../emails/mailer");
const T = require("../emails/templates");

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
    await sendEmail({
        to: u.email,
        subject,
        html,
        text,
        replyTo,
      });
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

    // Get membership product title (for copy)
    const { rows: prodRows } = await db.query(
      `SELECT id, title FROM products WHERE id=$1 LIMIT 1`,
      [productId]
    );
    const productTitle = prodRows?.[0]?.title || "your membership";

    // ✅ Include members who clicked "cancel", until current_period_end
    const { rows: members } = await db.query(
      `
      SELECT DISTINCT m.buyer_id AS user_id
        FROM memberships m
       WHERE m.product_id = $1
         AND m.status IN ('active','trialing')
         AND NOW() <= COALESCE(m.current_period_end, NOW())
      `,
      [productId]
    );

    console.log("[notifyPostToMembers] productId=%s eligible=%d", productId, members.length);
    if (!members.length) return;

    const postUrl = buildActionUrl("post", { postId });
    const msg = T.userMembershipNewPost({ productTitle, postUrl });

    const tasks = members.map(({ user_id }) =>
      Promise.allSettled([
        // In-app (always)
        notifyInApp(user_id, {
          type: "member_post",
          title: "New content posted",
          body: `New content from ${productTitle} has just been posted. Check it out on your My Purchases page!`,
          metadata: { creator_id: creatorId, product_id: productId, post_id: postId },
        }),
        // Email (respect user pref)
        sendIfUserPref(user_id, "notify_post", {
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
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

    // BUYER emails
    const buyerTasks = [];

    // For one-time downloads, send the “Your download is ready!” template
    if (o.product_type === "purchase") {
      const purchasesUrl = buildActionUrl("purchases");
      const msg = T.userPurchaseDownloadReady({ purchasesUrl });
      buyerTasks.push(
        sendIfUserPref(o.buyer_id, "notify_purchase", {
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        })
      );
    } else {
      // Fallback for other product types (unchanged copy)
      buyerTasks.push(
        sendIfUserPref(o.buyer_id, "notify_purchase", {
          subject: `Your ${o.product_type} purchase is confirmed`,
          html: `<p>Thanks! Your purchase of <strong>${o.title || "a product"}</strong> is confirmed.</p>
                 <p>You can view/download it from your purchases page.</p>`,
        })
      );
    }

    // In-app for buyer
    buyerTasks.push(
      notifyInApp(o.buyer_id, {
        type: "purchase",
        title: "Purchase confirmed",
        body: `Your ${o.product_type} "${o.title || "product"}" is confirmed.`,
        metadata: { order_id: o.order_id, product_id: o.product_id },
      })
    );

    // CREATOR notifications (leave copy as-is)
    const creatorTasks = [
      sendIfUserPref(o.creator_id, "notify_product_sale", {
        subject: `You made a sale 🎉`,
        html: `<p>Your ${o.product_type} "<strong>${o.title || "product"}</strong>" was just purchased.</p>`,
      }),
      notifyInApp(o.creator_id, {
        type: "product_sale",
        title: "You made a sale 🎉",
        body: `Your ${o.product_type} "${o.title || "product"}" was purchased.`,
        metadata: { order_id: o.order_id, product_id: o.product_id },
      }),
    ];

    await Promise.allSettled([...buyerTasks, ...creatorTasks]);
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

    // Deep link to the creator dashboard → requests tab (adjust if your UI path differs)
    const dashboardUrl = buildActionUrl("dashboard", { tab: "requests" });
    const msg = T.creatorNewRequest({ dashboardUrl });

      await sendIfUserPref(r.creator_id, "notify_new_request", {
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      });
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
      `SELECT cr.id, cr.buyer_id, p.title AS product_title
         FROM custom_requests cr
         JOIN orders o   ON o.id = cr.order_id
         JOIN products p ON p.id = o.product_id
        WHERE cr.id=$1`,
      [requestId]
    );
    const r = rows[0];
    if (!r) return;

    const purchasesUrl = buildActionUrl("purchases");
    const productTitle = r.product_title || "your request";
    const msg = T.userRequestCompleted({ productTitle, purchasesUrl });

    await Promise.allSettled([
      sendIfUserPref(r.buyer_id, "notify_request_completed", {
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
      notifyInApp(r.buyer_id, {
        type: "request_ready",
        title: "Your request is ready! 🎉",
        body: "Check it out on your My Purchases page!",
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
