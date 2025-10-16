// utils/videoPoster.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const mime = require("mime-types");
const storage = require("../storage");

// make poster path by replacing the extension with .jpg (matches your routes)
function posterKeyFor(videoKey) {
  return String(videoKey || "").replace(/\.[^./\\]+$/, "") + ".jpg";
}

function tmpFile(ext = ".tmp") {
  const name = `poster-${crypto.randomBytes(6).toString("hex")}${ext}`;
  return path.join(os.tmpdir(), name);
}

/**
 * Create and store a poster image for a stored video.
 * @param {string} videoKey - storage key of the uploaded video (e.g. "requests/abc/file.mp4")
 * @param {{ private?: boolean }} [opts]
 * @returns {Promise<{ key: string } | null>} poster key, or null if skipped (e.g. audio)
 */
async function makeAndStorePoster(videoKey, opts = {}) {
  if (!videoKey || typeof videoKey !== "string") {
    throw new Error("makeAndStorePoster: videoKey required");
  }

  // Try to read the stored file (supports S3/local via your storage.js)
  let meta;
  try {
    meta = await storage.getReadStreamAndMeta(videoKey, undefined);
  } catch (e) {
    throw new Error(`makeAndStorePoster: could not read source "${videoKey}": ${e?.message || e}`);
  }

  const contentType = String(meta.contentType || mime.lookup(videoKey) || "");
  const isAudio = contentType.toLowerCase().startsWith("audio/");
  if (isAudio) {
    // By design we skip posters for audio
    return null;
  }

  // Save the source to a temp file so ffmpeg can seek reliably
  const inTmp = tmpFile(path.extname(videoKey) || ".bin");
  const outJpg = tmpFile(".jpg");

  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(inTmp);
    meta.stream.on("error", reject);
    w.on("error", reject);
    w.on("finish", resolve);
    meta.stream.pipe(w);
  });

  // Generate a middle-frame screenshot
  await new Promise((resolve, reject) => {
    ffmpeg(inTmp)
      .on("end", resolve)
      .on("error", reject)
      .screenshots({
        timestamps: ["50%"],
        filename: path.basename(outJpg),
        folder: path.dirname(outJpg),
        size: "640x?"
      });
  });

  const jpgBuf = fs.readFileSync(outJpg);
  const posterKey = posterKeyFor(videoKey);

  // Store alongside the video; your routes read it with the same posterKey
  await storage.uploadPrivate({
    key: posterKey,
    contentType: "image/jpeg",
    body: jpgBuf,
  });

  // Cleanup temp files
  try { fs.unlinkSync(inTmp); } catch {}
  try { fs.unlinkSync(outJpg); } catch {}

   return storedKey;
}

module.exports = { makeAndStorePoster, posterKeyFor };
