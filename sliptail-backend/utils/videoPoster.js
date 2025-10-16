const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const os = require("os");
const mime = require("mime-types");
const storage = require("../storage"); // <- your storage.js dual driver

function tmpFile(ext = ".jpg") {
  const name = `poster-${crypto.randomBytes(6).toString("hex")}${ext}`;
  return path.join(os.tmpdir(), name);
}

/**
 * From a local temp video path, write a single JPEG poster to a temp file,
 * then upload via storage.uploadPrivate({ key, body, contentType }).
 *
 * @param {string} absVideoPath - local path where multer put the video
 * @param {string} keyStem - e.g. `posts/${postId}` (no extension)
 * @returns {Promise<{ key: string, url?: string }>} storage key, and for local a web path
 */
async function makeAndStorePoster(absVideoPath, keyStem) {
  const outJpg = tmpFile(".jpg");

  // 50% timestamp is a good neutral frame
  await new Promise((resolve, reject) => {
    ffmpeg(absVideoPath)
      .on("end", resolve)
      .on("error", reject)
      .screenshots({
        timestamps: ["50%"],
        filename: path.basename(outJpg),
        folder: path.dirname(outJpg),
        size: "640x?"
      });
  });

  const buf = fs.readFileSync(outJpg);
  const key = `${keyStem.replace(/^\/+/, "")}-poster.jpg`;

  // Works for both local & S3 drivers
  const { key: storedKey } = await storage.uploadPrivate({
    key,
    contentType: mime.lookup("jpg") || "image/jpeg",
    body: buf,
  });

  try { fs.unlinkSync(outJpg); } catch {}

  return { key: storedKey };
}

module.exports = { makeAndStorePoster };