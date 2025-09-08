function validate(schema) {
  return (req, res, next) => {
    try {
      const data = {
        body: req.body,
        params: req.params,
        query: req.query,
      };
      const parsed = schema.parse(data);
      // overwrite validated values so downstream uses sanitized data
      req.body = parsed.body || req.body;
      req.params = parsed.params || req.params;
      req.query = parsed.query || req.query;
      next();
    } catch (e) {
      const issues = e?.issues?.map(i => `${i.path.join(".")}: ${i.message}`) || ["Invalid request"];
      return res.status(400).json({ error: "Validation failed", details: issues });
    }
  };
}
module.exports = { validate };