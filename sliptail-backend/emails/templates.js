//**emails/templates.js
const BRAND = { company: "Sliptail" };
const baseCss = `
  body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; margin:0; background:#f6f7fb; color:#111827; }
  .container { max-width:560px; margin:24px auto; background:#fff; border-radius:14px; overflow:hidden; box-shadow:0 6px 20px rgba(0,0,0,0.06); }
  .header { padding:18px 24px; background:#111827; color:#fff; }
  .brand { display:flex; align-items:center; gap:12px; font-weight:700; }
  .content { padding:22px 24px 28px; }
  h1 { font-size:20px; margin:0 0 12px 0; }
  p { line-height:1.55; margin:10px 0; }
  .btn { display:inline-block; padding:12px 18px; border-radius:10px; background:#111827; color:#fff !important; text-decoration:none; font-weight:600; }
  .muted { color:#6b7280; font-size:12px; margin-top:14px; }
  .footer { text-align:center; color:#9ca3af; font-size:12px; padding:16px 12px 28px; }
`;
function wrap(subject, bodyHtml) {
  const year = new Date().getFullYear();
  return `
<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${subject}</title><style>${baseCss}</style></head>
<body>
  <div class="container">
    <div class="header">
      <div class="brand">
        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#22d3ee;"></span>
        <span>${BRAND.company}</span>
      </div>
    </div>
    <div class="content">
      ${bodyHtml}
      <div class="muted">If you didn’t request this, you can safely ignore this email.</div>
    </div>
    <div class="footer">© ${year} ${BRAND.company}. All rights reserved.</div>
  </div>
</body></html>`;
}

/* ====== 8 templates (subject + html + text) ====== */
exports.emailVerification = ({ actionUrl, expiresInMinutes = 60 }) => ({
  subject: "Please Verify Your Email Address",
  html: wrap("Please Verify Your Email Address", `
    <h1>Verify your email</h1>
    <p>Thanks for signing up for ${BRAND.company}! Please verify your email address to complete your registration.</p>
    <p><a class="btn" href="${actionUrl}">Verify Email Address</a></p>
    <p class="muted">This link expires in ${expiresInMinutes} minutes.</p>
  `),
  text: `Verify your email\n\nThanks for signing up for ${BRAND.company}!\nVerify link: ${actionUrl}\nThis link expires in ${expiresInMinutes} minutes.\n`,
});

exports.passwordReset = ({ actionUrl }) => ({
  subject: "Reset Your Password",
  html: wrap("Reset Your Password", `
    <h1>Reset your password</h1>
    <p>We received a request to reset the password for your ${BRAND.company} account.</p>
    <p><a class="btn" href="${actionUrl}">Reset Password</a></p>
    <p class="muted">This link expires in 30 minutes.</p>
  `),
  text: `Reset your password\n\nWe received a request to reset the password for your ${BRAND.company} account.\nReset link: ${actionUrl}\nThis link expires in 30 minutes.\n`,
});

exports.accountAccessLink = ({ actionUrl }) => ({
  subject: "Set your Sliptail password",
  html: wrap("Set your Sliptail password", `
    <h1>Set your password</h1>
    <p>We created a Sliptail account for you so you can manage your purchases and memberships.</p>
      <p>
      <a
        class="btn"
        href="${actionUrl}"
        style="color:#ffffff !important;"
      >
        Set password and access your account
      </a>
    </p>
    <p class="muted">This link expires in 7 Days.</p>
  `),
  text: `Set your password

We created a Sliptail account for you so you can manage your purchases and memberships.
Set password: ${actionUrl}
This link expires in 7 Days.
`,
});

exports.newEmailVerification = ({ actionUrl }) => ({
  subject: "Please Verify Your New Email",
  html: wrap("Please Verify Your New Email", `
    <h1>Verify your new email</h1>
    <p>You requested to update the email on your ${BRAND.company} account.</p>
    <p><a class="btn" href="${actionUrl}">Verify New Email</a></p>
  `),
  text: `Verify your new email\n\nYou requested to update the email on your ${BRAND.company} account.\nVerify link: ${actionUrl}\n`,
});

exports.userMembershipNewPost = ({ productTitle, postUrl }) => ({
  subject: `New Post from ${productTitle} Just for You 🎉`,
  html: wrap(`New Post from ${productTitle} Just for You 🎉`, `
    <h1>New post for ${productTitle}</h1>
    <p>A new post has been published for your membership.</p>
    <p><a class="btn" href="${postUrl}">View the post</a></p>
  `),
  text: `New post for ${productTitle}\n\nA new post has been published for your membership.\nView the post: ${postUrl}\n`,
});

exports.userRequestCompleted = ({ productTitle, purchasesUrl }) => ({
  subject: "Your Request Has Been Completed",
  html: wrap("Your Request Has Been Completed", `
    <h1>Your request is complete</h1>
    <p>Your creator has completed your request: <strong>${productTitle}</strong>.</p>
    <p><a class="btn" href="${purchasesUrl}">View Request</a></p>
  `),
  text: `Your request is complete\n\nYour creator has completed your request: ${productTitle}.\nView request: ${purchasesUrl}\n`,
});

exports.userRequestRefunded = ({ productTitle }) => {
  const safeTitle = productTitle || "your custom request";

  return {
    subject: "Your custom request has been refunded",
    html: wrap("Your custom request has been refunded", `
      <h1>Your request has been refunded</h1>
      <p>Hello,</p>
      <p>Your custom request for <strong>${safeTitle}</strong> has been refunded. The payment has been returned to your original payment method and refunds typically appear back on your account in 3 to 10 business days depending on your bank (14 days outside US).</p>
      <p>If you have any questions please reach out to support at <a href="mailto:info@sliptail.com">info@sliptail.com</a>!</p>
    `),
    text: `Hello,

Your custom request for ${safeTitle} has been refunded. The payment has been returned to your original payment method and refunds typically appear back on your account in 3 to 10 business days depending on your bank (14 days outside US).

If you have any questions please reach out to support at info@sliptail.com!
`,
  };
};

exports.userPurchaseDownloadReady = ({ purchasesUrl }) => ({
  subject: "Your download is ready!",
  html: wrap("Your download is ready!", `
    <h1>Your download is ready</h1>
    <p>Thanks for your purchase! Your file is now available.</p>
    <p><a class="btn" href="${purchasesUrl}">Download</a></p>
  `),
  text: `Your download is ready\n\nThanks for your purchase! Your file is now available.\nDownload: ${purchasesUrl}\n`,
});

exports.userMembershipRenewsSoon = ({ purchasesUrl }) => ({
  subject: "Your Membership Will Renew in 3 Days",
  html: wrap("Your Membership Will Renew in 3 Days", `
    <h1>Membership renews soon</h1>
    <p>Hi, just a quick reminder — your membership will automatically renew in 3 days.</p>
    <p>No action is needed if you wish to continue — it will renew as scheduled.</p>
    <p><a class="btn" href="${purchasesUrl}">Go to My Purchases</a></p>
  `),
  text: `Membership renews soon\n\nHi, your membership will renew in 3 days.\nManage subscription: ${purchasesUrl}\n`,
});

exports.creatorNewRequest = ({ dashboardUrl }) => ({
  subject: "You’ve Got a New Request",
  html: wrap("You’ve Got a New Request", `
    <h1>New request received</h1>
    <p>Great news! You’ve received a new request.</p>
    <p><a class="btn" href="${dashboardUrl}">View Request</a></p>
    <p class="muted">Your supporter is waiting to hear back from you.</p>
  `),
  text: `New request received\n\nGreat news! You’ve received a new request.\nView request: ${dashboardUrl}\n`,
});