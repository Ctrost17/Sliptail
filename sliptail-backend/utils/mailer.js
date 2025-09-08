const nodemailer = require("nodemailer");

const {
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
} = process.env;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: false, // true only for 465
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

async function sendMail({ to, subject, html }) {
  if (!to || !subject || !html) throw new Error("Missing to/subject/html");
  const from = SMTP_FROM || "no-reply@example.com";
  return transporter.sendMail({ from, to, subject, html });
}

module.exports = { sendMail };