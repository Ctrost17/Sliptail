// utils/faststart.js
const { execFile } = require("child_process");
const util = require("util");
const execFileP = util.promisify(execFile);
const os = require("os");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const storage = require("../storage");

// download S3/private object (or local) to a temp file using your storage layer
async function downloadToFile(key, tmpPath) {
  const { stream } = await storage.getReadStreamAndMeta(key);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    stream.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    stream.pipe(out);
  });
}

/**
 * ensureFastStart(key)
 * - Only touches .mp4
 * - Moves 'moov' atom to the front: instant start + scrubbing
 * - Overwrites the same key (keeps your DB + URLs unchanged)
 */
async function ensureFastStart(key) {
  if (!key || !/\.mp4$/i.test(String(key))) return;

  const inPath  = path.join(os.tmpdir(), `fs-in-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  const outPath = path.join(os.tmpdir(), `fs-out-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);

  try {
    await downloadToFile(key, inPath);

    // Remux only (no quality loss)
    await execFileP("ffmpeg", [
      "-y", "-i", inPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outPath
    ], { maxBuffer: 10_000_000 });

    // Overwrite the same object/key so existing signed URLs keep working
    await storage.uploadPrivate({ key, contentType: "video/mp4", body: outPath });
  } catch (e) {
    console.warn("faststart remux failed:", e?.message || e);
  } finally {
    fsp.unlink(inPath).catch(() => {});
    fsp.unlink(outPath).catch(() => {});
  }
}

module.exports = { ensureFastStart };