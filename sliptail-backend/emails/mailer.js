// emails/mailer.js
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const crypto = require("crypto");

const ses = new SESClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  } : undefined
});

function absoluteUrl(path = "/") {
  const base = process.env.APP_ORIGIN || "http://localhost:3000";
  return path.startsWith("http") ? path : `${base}${path}`;
}

// Simple signed token for email links (use your JWT if you already have one)
function makeToken(payload, ttlSec = 1800) { // default 30 min
  const data = { ...payload, exp: Math.floor(Date.now()/1000) + ttlSec };
  const raw = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.EMAIL_LINK_SECRET || "devsecret")
    .update(raw).digest("base64url");
  return `${raw}.${sig}`;
}

function buildActionUrl(kind, payload = {}, ttlSec = 1800) {
  const token = makeToken(payload, ttlSec);
  switch (kind) {
    case "verify-email":     return absoluteUrl(`/verify-email?token=${token}`);
    case "reset-password":   return absoluteUrl(`/reset-password?token=${token}`);
    case "verify-new-email": return absoluteUrl(`/verify-new-email?token=${token}`);
    case "post":             return absoluteUrl(`/purchases?postId=${payload.postId || ""}`);
    case "purchases":        return absoluteUrl(`/purchases`);
    case "dashboard":        return absoluteUrl(`/dashboard?tab=requests`);
    default:                 return absoluteUrl(`/`);
  }
}

/** Send an HTML email via SES. */
async function sendEmail({ to, subject, html, text, from, replyTo }) {
  const Source = from || process.env.SLIPTAIL_MAIL_FROM;
  if (!Source) throw new Error("SLIPTAIL_MAIL_FROM is required");

  const params = {
    Source,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: {
        Html: { Data: html, Charset: "UTF-8" },
        Text: { Data: text || "", Charset: "UTF-8" }
      }
    }
  };
  if (replyTo) params.ReplyToAddresses = [replyTo];

  return ses.send(new SendEmailCommand(params));
}

module.exports = { sendEmail, buildActionUrl };
