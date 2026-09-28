// Errors that carry an HTTP status, so routes can turn them into responses in one place.
class AppError extends Error {
  constructor(message, status = 500, details) {
    super(message);
    this.status = status;
    if (details) this.details = details;
  }
}
const badRequest = (msg, details) => new AppError(msg, 400, details);
const unauthorized = msg => new AppError(msg || 'Invalid or missing API key', 401);
const forbidden = msg => new AppError(msg || 'Forbidden', 403);
const notFound = msg => new AppError(msg || 'Not found', 404);
const conflict = msg => new AppError(msg, 409);
const tooLarge = msg => new AppError(msg, 413);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict, tooLarge };
