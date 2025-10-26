// utils/disposition.js (new tiny helper)
function buildDisposition(type, name) {
  const base = (name || "download").replace(/[^\w.\- ]+/g, "_").trim() || "download";
  const enc = encodeURIComponent(base);
  return `${type}; filename="${enc}"; filename*=UTF-8''${enc}`;
}
module.exports = { buildDisposition };