//utils/video.js
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
ffmpeg.setFfmpegPath(ffmpegPath);

function needsTranscode(mimetype, ext) {
  const e = (ext || "").toLowerCase();
  // Already MP4? then skip
  if (mimetype === "video/mp4" && (e === ".mp4" || e === ".m4v")) return false;
  // Any other video type -> transcode
  return (mimetype || "").startsWith("video/");
}

function transcodeToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-movflags +faststart",
        "-vcodec libx264",
        "-acodec aac",
        "-crf 23",
        "-preset veryfast",
      ])
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .save(outputPath);
  });
}

module.exports = { needsTranscode, transcodeToMp4 };