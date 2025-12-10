// middleware/hcaptcha.js
const https = require("https");
const querystring = require("querystring");

function verifyHCaptcha(token, remoteIp) {
  return new Promise((resolve) => {
    const secret = process.env.HCAPTCHA_SECRET_KEY;
    if (!secret) {
      console.error("HCAPTCHA_SECRET_KEY not set");
      return resolve(false);
    }

    const postData = querystring.stringify({
      secret,
      response: token,
      remoteip: remoteIp || "",
    });

    const req = https.request(
      {
        hostname: "hcaptcha.com",
        path: "/siteverify",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(!!parsed.success);
          } catch (err) {
            console.error("hCaptcha parse error", err);
            resolve(false);
          }
        });
      }
    );

    req.on("error", (err) => {
      console.error("hCaptcha request error", err);
      resolve(false);
    });

    req.write(postData);
    req.end();
  });
}

async function requireHCaptcha(req, res, next) {
  try {
    const token =
      req.body?.hcaptchaToken ||
      req.body?.hCaptchaToken ||
      req.body?.["h-captcha-response"];

    if (!token) {
      return res.status(400).json({ error: "Missing hCaptcha token" });
    }

    const remoteIp =
      (req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim() || req.socket?.remoteAddress;

    const ok = await verifyHCaptcha(token, remoteIp);
    if (!ok) {
      return res.status(400).json({ error: "Failed hCaptcha verification" });
    }

    return next();
  } catch (err) {
    console.error("requireHCaptcha error", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = {
  requireHCaptcha,
};
