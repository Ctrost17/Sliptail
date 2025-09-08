const db = require("../db");
const { sendMail } = require("./mailer");

function renderHtml(template, payload = {}) {
  if (template === "verify_email") {
    const url = payload.verify_url || "#";
    return `<h2>Verify your email</h2><p><a href="${url}">${url}</a></p>`;
  }
  if (template === "reset_password") {
    const url = payload.reset_url || "#";
    return `<h2>Reset your password</h2><p><a href="${url}">${url}</a></p>`;
  }
  return `<pre>${template}</pre><pre>${JSON.stringify(payload, null, 2)}</pre>`;
}

async function enqueueAndSend({ to, subject, template, payload }) {
  let rec;
  try {
    const { rows } = await db.query(
      `INSERT INTO email_queue (to_email, subject, template, payload_json, status, attempts, created_at)
       VALUES ($1,$2,$3,$4,'pending',0,NOW())
       RETURNING *`,
      [to, subject, template || null, JSON.stringify(payload || {})]
    );
    rec = rows[0];

    const html = renderHtml(template, payload);
    await sendMail({ to, subject, html });

    await db.query(
      `UPDATE email_queue SET status='sent', sent_at=NOW(), attempts=attempts+1 WHERE id=$1`,
      [rec.id]
    );
  } catch (e) {
    if (rec) {
      await db.query(
        `UPDATE email_queue SET status='failed', last_error=$2, attempts=attempts+1 WHERE id=$1`,
        [rec.id, e.message || String(e)]
      );
    }
    // Don’t rethrow in signup path if you don’t want to fail; your route already wraps with try/catch.
    throw e;
  }
}

module.exports = { enqueueAndSend };