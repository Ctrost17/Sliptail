class ApiError extends Error {
  constructor(status = 500, message = "Internal server error", details = null) {
    super(message);
    this.status = status;
    this.details = details;
    // mark safe-to-show messages for 4xx; hide 5xx by default
    this.expose = status >= 400 && status < 500;
  }
}

const createError = (status, message, details) => new ApiError(status, message, details);

// If no route matched
const notFound = (req, res, next) => {
  next(createError(404, "Not found"));
};

// Centralized error responder
const errorHandler = (err, req, res, next) => {
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;

  // For 5xx, don’t leak internals in production
  const safeMessage =
    status >= 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message || "Error";

  const payload = { error: safeMessage };

  if (err.details) payload.details = err.details;

  // Include stack only outside production
  if (process.env.NODE_ENV !== "production" && err.stack) {
    payload.stack = err.stack;
  }

  // Optional: quick request tracing
  // payload.requestId = req.headers["x-request-id"];

  res.status(status).json(payload);
};

// Optional helper: wrap async route handlers to auto-forward errors
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  ApiError,
  createError,
  notFound,
  errorHandler,
  asyncHandler,
};